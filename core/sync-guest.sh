# shellcheck shell=bash
# vm_sync, the VM side. core/sync.mjs sends this text with every call (it is never installed), after
# assignments to MODE (probe | apply), DIR, for probe WANT, and for apply: FORMAT BUNDLE SNAP HEAD_SHA
# TREE EXPECT_SYNCED EXPECT_HEAD. It never contacts a git remote. Output: key=value lines on stdout.
# Exit 3: refused (the reason on stderr); the checkout is as it was. Exit 1: failed; apply has restored
# the checkout it found, or says it couldn't.
#
# State kept in the VM repo: refs/boxery/synced (the snapshot commit of the last sync: local HEAD plus
# the working changes, as one commit), refs/boxery/base (local HEAD then), and while a swap runs,
# $G/boxery-sync-pending ("OLD_TREE NEW_TREE") so a later sync can finish or undo an interrupted one.
set -u -o pipefail
: "${MODE:?}" "${DIR:?}"
export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 GIT_LFS_SKIP_SMUDGE=1
LOCKFILES=(':(glob)**/pnpm-lock.yaml' ':(glob)**/package-lock.json' ':(glob)**/yarn.lock' ':(glob)**/bun.lock')
refuse() { printf '%s\n' "$*" >&2; exit 3; }
die() { printf '%s\n' "$*" >&2; exit 1; }
rev() { git rev-parse -q --verify "$1^{commit}" 2>/dev/null || true; }
is_repo_root() { local top; top=$(git rev-parse --show-toplevel 2>/dev/null) && [ "$top" = "$(pwd -P)" ]; }
# A directory inside another repository's working tree would show up there as a new nested repository.
inside_other_repo() {
	local top
	top=$(cd "$1" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || return 1
	[ -n "$top" ] && [ "$top" != "$2" ] && printf '%s' "$top"
}
setup_git() {
	G=$(git rev-parse --absolute-git-dir) || die "git: cannot find the repository in $DIR"
	OBJ=$(git rev-parse --path-format=absolute --git-path objects) || die "git is too old (needs 2.31+)"
	IDX=$(git rev-parse --path-format=absolute --git-path index)
	EMPTY=$(git hash-object -t tree /dev/null)
}
# The tree to compare the working directory with: the last sync's, else HEAD's, else nothing.
baseline() {
	local s h; s=$(rev refs/boxery/synced); h=$(rev HEAD)
	if [ -n "$s" ]; then git rev-parse "$s^{tree}"; elif [ -n "$h" ]; then git rev-parse "$h^{tree}"; else echo "$EMPTY"; fi
}
# The working directory as a tree, as `git add -A` sees it (tracked files plus untracked ones that
# aren't ignored), starting from tree $1. Uses a scratch index and object directory, so neither the
# repo's index nor its object store changes.
wt() {
	local t rc
	t=$(mktemp -d) || return 1
	mkdir "$t/o"
	[ ! -f "$IDX" ] || cp "$IDX" "$t/i"
	(
		export GIT_INDEX_FILE="$t/i" GIT_OBJECT_DIRECTORY="$t/o" GIT_ALTERNATE_OBJECT_DIRECTORIES="$OBJ"
		# One-tree --reset keeps the copied index's stat data for entries it doesn't change, so unchanged
		# files aren't hashed again, and (unlike -m) doesn't refuse entries that aren't up to date.
		git read-tree --reset "$1" && git add -A 2>/dev/null && git write-tree
	)
	rc=$?; rm -rf "$t"; return "$rc"
}
# Up to 20 changes from tree $1 to tree $2 (both trees' objects must exist).
changes() { { git diff-tree -r --no-renames --name-status "$1" "$2" 2>/dev/null || true; } | head -n 20; }
# Up to 20 changes from tree $1 to the working directory.
worktree_changes() {
	local t
	t=$(mktemp -d) || return 1
	mkdir "$t/o"
	(
		export GIT_INDEX_FILE="$t/i" GIT_OBJECT_DIRECTORY="$t/o" GIT_ALTERNATE_OBJECT_DIRECTORIES="$OBJ"
		git read-tree "$1" && git add -A 2>/dev/null && w=$(git write-tree) && changes "$1" "$w"
	)
	rm -rf "$t"
}

probe() {
	if [ ! -e "$DIR" ]; then
		local up; up=$(dirname "$DIR"); while [ ! -d "$up" ]; do up=$(dirname "$up"); done
		local other; other=$(inside_other_repo "$up" "") && refuse "$DIR is inside the git checkout $other; sync into a directory outside it"
		echo state=absent; return
	fi
	[ -d "$DIR" ] || refuse "$DIR exists and is not a directory"
	cd "$DIR" || die "cannot enter $DIR"
	if ! is_repo_root; then
		local other; other=$(inside_other_repo . "") && refuse "$DIR is inside the git checkout $other; sync into a directory outside it"
		local entries; entries=$(ls -A)
		if [ -n "$entries" ]; then echo state=dir; printf '%s\n' "$entries" | head -n 5 | sed 's/^/entry=/'; else echo state=empty; fi
		return
	fi
	local outer; outer=$(inside_other_repo .. "") && refuse "$DIR is inside the git checkout $outer; sync into a directory outside it"
	setup_git
	echo state=repo
	echo "format=$(git rev-parse --show-object-format)"
	echo "synced=$(rev refs/boxery/synced)"
	echo "base=$(rev refs/boxery/base)"
	echo "head=$(rev HEAD)"
	[ -z "${WANT:-}" ] || ! git cat-file -e "$WANT^{commit}" 2>/dev/null || echo has=1
	if [ -f "$G/boxery-sync-pending" ]; then echo pending=1; return; fi
	local b w
	b=$(baseline) || die "cannot read the last sync's state in $DIR"
	echo "baseline=$b"
	w=$(wt "$b") || die "cannot read the working directory of $DIR"
	echo "worktree=$w"
	[ "$w" = "$b" ] || worktree_changes "$b" | sed 's/^/changed=/'
}

# Put back tree $1 where tree $2 was swapped in (or half swapped in), and the index found before.
rollback() {
	GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree "$2" &&
		GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree --reset -u "$2" "$1" || return 1
	restore_index
}
restore_index() {
	if [ -f "$G/boxery-sync-index.bak" ]; then mv -f "$G/boxery-sync-index.bak" "$IDX"; else rm -f "$IDX"; fi
	git update-ref -d refs/boxery/incoming 2>/dev/null
	rm -f "$G/boxery-sync-index" "$G/boxery-sync-pending"
}
# A swap a crash interrupted: done if its refs were written, otherwise undone, but only if every file it
# would put back is still as the swap left it (old, new or absent); anything else is a VM edit.
recover() {
	[ -f "$G/boxery-sync-pending" ] || return 0
	local old new s cur foreign
	read -r old new <"$G/boxery-sync-pending" || die "unreadable $G/boxery-sync-pending"
	s=$(rev refs/boxery/synced)
	if [ -n "$s" ] && [ "$(git rev-parse "$s^{tree}")" = "$new" ]; then
		rm -f "$G/boxery-sync-pending" "$G/boxery-sync-index" "$G/boxery-sync-index.bak"
		return 0
	fi
	cur=$(mktemp -d) || die "mktemp failed"
	mkdir "$cur/o"
	foreign=$(
		export GIT_INDEX_FILE="$cur/i" GIT_OBJECT_DIRECTORY="$cur/o" GIT_ALTERNATE_OBJECT_DIRECTORIES="$OBJ"
		git read-tree "$old" && git add -A 2>/dev/null && w=$(git write-tree) || exit 1
		# A path that differs from both the old and the new tree is neither ours nor untouched.
		comm -12 <(git diff-tree -r --no-renames --name-only "$old" "$w" | sort) <(git diff-tree -r --no-renames --name-only "$new" "$w" | sort)
	) || { rm -rf "$cur"; die "cannot read the working directory of $DIR"; }
	rm -rf "$cur"
	[ -z "$foreign" ] || refuse "an interrupted earlier sync left $DIR half updated, and these files were changed since: $(printf '%s\n' "$foreign" | head -n 20 | tr '\n' ' ')
Save or discard them in the VM, then sync again (the interrupted sync is undone first)"
	rollback "$old" "$new" || die "an interrupted sync left $DIR half updated and it could not be undone; see $G/boxery-sync-pending"
}
# Paths the new tree adds that already exist in the VM: ignored files (apply checked nothing else is
# untracked) the swap would overwrite or delete. A directory counts if it holds ignored files.
clobbered() {
	local p d
	while IFS= read -r -d '' p; do
		if [ -L "$p" ] || [ -f "$p" ]; then printf '%s\n' "$p"; continue; fi
		if [ -d "$p" ]; then
			[ -z "$(git ls-files -z --others --ignored --exclude-standard --directory -- "$p" | head -c1)" ] || printf '%s/\n' "$p"
			continue
		fi
		d=$(dirname "$p")
		while [ "$d" != . ]; do
			if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then printf '%s\n' "$d"; break; fi
			[ ! -d "$d" ] || break
			d=$(dirname "$d")
		done
	done < <(git diff-tree -r -z --no-renames --diff-filter=A --name-only "$1" "$2")
}
# Swap tree $1 for $2 in the working directory. 2: git refused before writing anything (a file changed
# under it). 4: done, but the result isn't $TREE (new ignore rules expose VM files). 1: other failure.
swap() {
	GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree "$1" || return 1
	GIT_INDEX_FILE="$G/boxery-sync-index" git update-index -q --refresh >/dev/null 2>&1
	# Two-tree merge: rewrites only the paths that differ and deletes what $2 lacks; ignored files stay.
	# git checks every path first and writes nothing if one changed since apply looked.
	GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree -m -u "$1" "$2" 2>"$G/boxery-sync-err" || return 2
	rm -f "$G/boxery-sync-err"
	RESULT=$(wt "$2") || return 1
	[ "$RESULT" = "$TREE" ] || return 4
	return 0
}

apply() {
	: "${FORMAT:?}" "${SNAP:?}" "${HEAD_SHA:?}" "${TREE:?}" "${BUNDLE?}" "${EXPECT_SYNCED?}" "${EXPECT_HEAD?}"
	# Past this point the caller has committed: finish or roll back, even if it cancels or disconnects.
	trap '' INT TERM HUP PIPE
	LOCKDIR=""
	trap 'rm -f "${BUNDLE:-/nonexistent}"; [ -z "$LOCKDIR" ] || rmdir "$LOCKDIR" 2>/dev/null' EXIT
	if [ ! -d "$DIR" ] || [ -z "$(ls -A "$DIR")" ]; then
		[ -z "$EXPECT_HEAD$EXPECT_SYNCED" ] || refuse "the checkout in $DIR changed during the sync; run it again"
		mkdir -p "$DIR" && cd "$DIR" || die "cannot create $DIR"
		git init -q --object-format="$FORMAT" || die "git init failed in $DIR"
	else
		cd "$DIR" || die "cannot enter $DIR"
		is_repo_root || refuse "$DIR is not a git repository and is not empty"
	fi
	setup_git
	if command -v flock >/dev/null; then
		exec 9>"$G/boxery-sync.lock"
		flock -w 60 9 || refuse "another sync into $DIR is running"
	else
		local i=0
		until mkdir "$G/boxery-sync.lock.d" 2>/dev/null; do
			i=$((i + 1)); [ "$i" -lt 600 ] || refuse "another sync into $DIR is running (or $G/boxery-sync.lock.d is stale: remove it)"
			sleep 0.1
		done
		LOCKDIR="$G/boxery-sync.lock.d"
	fi
	recover
	[ "$(rev refs/boxery/synced)" = "$EXPECT_SYNCED" ] && [ "$(rev HEAD)" = "$EXPECT_HEAD" ] ||
		refuse "the checkout in $DIR changed during the sync; run it again"
	local b w new prev lock=0 hit rc
	b=$(baseline) || die "cannot read the last sync's state in $DIR"
	w=$(wt "$b") || die "cannot read the working directory of $DIR"
	[ "$w" = "$b" ] || refuse "uncommitted changes appeared in $DIR during the sync; run it again"
	if [ -n "$BUNDLE" ]; then
		git bundle verify -q "$BUNDLE" >/dev/null 2>&1 || die "the bundle doesn't apply to the VM's repository"
		git fetch -q --no-tags --no-write-fetch-head "$BUNDLE" "+refs/heads/sync:refs/boxery/incoming" || die "git fetch from the bundle failed"
		rm -f "$BUNDLE"
	fi
	git cat-file -e "$SNAP^{commit}" 2>/dev/null || die "the VM lacks commit $SNAP after the transfer"
	new=$(git rev-parse "$SNAP^{tree}") || die "cannot read $SNAP"
	hit=$(clobbered "$b" "$new" | head -n 20) || die "cannot compare the new tree with $DIR"
	if [ -n "$hit" ]; then
		git update-ref -d refs/boxery/incoming 2>/dev/null
		refuse "the local checkout now tracks paths that exist in the VM as ignored files (build output, dependencies), which the sync would overwrite or delete: $(printf '%s\n' "$hit" | tr '\n' ' ')
Remove them in the VM (or stop tracking them locally), then sync again"
	fi
	prev=$(rev refs/boxery/synced); [ -n "$prev" ] || prev=$(rev HEAD)
	git diff --quiet "${prev:-$EMPTY}" "$SNAP" -- "${LOCKFILES[@]}" || lock=1
	rm -f "$G/boxery-sync-index.bak"
	[ ! -f "$IDX" ] || cp "$IDX" "$G/boxery-sync-index.bak" || die "cannot back up the index"
	printf '%s %s\n' "$b" "$new" >"$G/boxery-sync-pending" || die "cannot write $G/boxery-sync-pending"
	swap "$b" "$new"; rc=$?
	case $rc in
	0) ;;
	2)
		local why; why=$(head -c 2000 "$G/boxery-sync-err" 2>/dev/null); rm -f "$G/boxery-sync-err"
		restore_index
		refuse "files in $DIR changed during the sync; run it again ($why)" ;;
	4)
		local extra; extra=$(worktree_changes "$new")
		rollback "$b" "$new" || die "the sync failed and the checkout in $DIR could not be restored; see $G/boxery-sync-pending"
		refuse "with the new .gitignore, files in the VM that were ignored no longer are: $(printf '%s\n' "$extra" | tr '\t\n' '  ')
Remove them in the VM (or ignore them locally), then sync again" ;;
	*)
		rollback "$b" "$new" || die "the sync failed and the checkout in $DIR could not be restored; see $G/boxery-sync-pending"
		die "the sync failed; the checkout in $DIR was restored" ;;
	esac
	# The index holds local HEAD, so `git status` in the VM shows the working changes, as it does locally.
	if ! { git read-tree "$HEAD_SHA" && printf '%s\n' 'option no-deref' "update HEAD $HEAD_SHA" "update refs/boxery/synced $SNAP" \
		"update refs/boxery/base $HEAD_SHA" 'delete refs/boxery/incoming' | git update-ref -m "boxery sync" --stdin; }; then
		rollback "$b" "$new" || die "the sync failed and the checkout in $DIR could not be restored; see $G/boxery-sync-pending"
		die "the sync failed writing refs; the checkout in $DIR was restored"
	fi
	git update-index -q --refresh >/dev/null 2>&1
	rm -f "$G/boxery-sync-pending" "$G/boxery-sync-index" "$G/boxery-sync-index.bak"
	echo "lockfile_changed=$lock"
	echo "tree=$RESULT"
}

case "$MODE" in
probe) probe ;;
apply) apply ;;
*) die "unknown mode $MODE" ;;
esac
