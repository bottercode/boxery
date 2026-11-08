# shellcheck shell=bash
# vm_sync, the VM side. core/sync.mjs sends this text with every call (it is never installed), after
# assignments to MODE (probe | apply), DIR, for probe WANT, and for apply: FORMAT BUNDLE SNAP HEAD_SHA EXPECT_SYNCED EXPECT_HEAD.
# It never contacts a git remote. Output: key=value lines on stdout. Exit 3: refused, nothing changed
# (the reason on stderr). Exit 1: failed; apply has restored the checkout it found.
#
# State kept in the VM repo: refs/boxery/synced (the snapshot commit of the last sync: local HEAD plus
# the working changes, as one commit), refs/boxery/base (local HEAD then), and while a swap runs,
# $G/boxery-sync-pending ("OLD_TREE NEW_TREE") so a later sync can finish or undo an interrupted one.
set -u
: "${MODE:?}" "${DIR:?}"
export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
LOCKFILES=(':(glob)**/pnpm-lock.yaml' ':(glob)**/package-lock.json' ':(glob)**/yarn.lock' ':(glob)**/bun.lock')
refuse() { printf '%s\n' "$*" >&2; exit 3; }
die() { printf '%s\n' "$*" >&2; exit 1; }
rev() { git rev-parse -q --verify "$1^{commit}" 2>/dev/null || true; }
is_repo_root() { local top; top=$(git rev-parse --show-toplevel 2>/dev/null) && [ "$top" = "$(pwd -P)" ]; }
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
# repo's index nor its object store changes. With $2 = diff, also lists up to 20 changes against $1.
wt() {
	local t rc
	t=$(mktemp -d) || return 1
	mkdir "$t/o"
	[ ! -f "$IDX" ] || cp "$IDX" "$t/i"
	(
		export GIT_INDEX_FILE="$t/i" GIT_OBJECT_DIRECTORY="$t/o" GIT_ALTERNATE_OBJECT_DIRECTORIES="$OBJ"
		# One-tree --reset keeps the copied index's stat data for entries it doesn't change, so unchanged
		# files aren't hashed again, and (unlike -m) doesn't refuse entries that aren't up to date.
		git read-tree --reset "$1" || exit 1
		git add -A 2>/dev/null || exit 1
		tree=$(git write-tree) || exit 1
		echo "$tree"
		if [ "${2:-}" = diff ] && [ "$tree" != "$1" ]; then
			git diff-tree -r --no-renames --name-status "$1" "$tree" | head -n 20 | sed 's/^/changed=/'
		fi
	)
	rc=$?; rm -rf "$t"; return "$rc"
}

probe() {
	if [ ! -e "$DIR" ]; then echo state=absent; return; fi
	[ -d "$DIR" ] || refuse "$DIR exists and is not a directory"
	cd "$DIR" || die "cannot enter $DIR"
	if ! is_repo_root; then
		if [ -n "$(ls -A)" ]; then echo state=dir; ls -A | head -n 5 | sed 's/^/entry=/'; else echo state=empty; fi
		return
	fi
	setup_git
	echo state=repo
	echo "format=$(git rev-parse --show-object-format)"
	echo "synced=$(rev refs/boxery/synced)"
	echo "base=$(rev refs/boxery/base)"
	echo "head=$(rev HEAD)"
	[ -z "${WANT:-}" ] || ! git cat-file -e "$WANT^{commit}" 2>/dev/null || echo has=1
	if [ -f "$G/boxery-sync-pending" ]; then echo pending=1; return; fi
	local b; b=$(baseline)
	echo "baseline=$b"
	wt "$b" diff | sed '1s/^/worktree=/' || die "cannot read the working directory of $DIR"
}

# Put back tree $1 where tree $2 was swapped in (or half swapped in), and the index found before.
rollback() {
	GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree "$2" &&
		GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree --reset -u "$2" "$1" || return 1
	if [ -f "$G/boxery-sync-index.bak" ]; then mv -f "$G/boxery-sync-index.bak" "$IDX"; else rm -f "$IDX"; fi
	git update-ref -d refs/boxery/incoming 2>/dev/null
	rm -f "$G/boxery-sync-index" "$G/boxery-sync-pending"
}
# A swap a crash interrupted: done if its refs were written, otherwise undone.
recover() {
	[ -f "$G/boxery-sync-pending" ] || return 0
	local old new s
	read -r old new <"$G/boxery-sync-pending" || die "unreadable $G/boxery-sync-pending"
	s=$(rev refs/boxery/synced)
	if [ -n "$s" ] && [ "$(git rev-parse "$s^{tree}")" = "$new" ]; then
		rm -f "$G/boxery-sync-pending" "$G/boxery-sync-index" "$G/boxery-sync-index.bak"
	else
		rollback "$old" "$new" || die "an interrupted sync left $DIR half updated and it could not be undone; see $G/boxery-sync-pending"
	fi
}
# Swap tree $1 for $2 in the working directory, then point the index, HEAD and our refs at the new state.
swap() {
	GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree "$1" || return 1
	GIT_INDEX_FILE="$G/boxery-sync-index" git update-index -q --refresh >/dev/null 2>&1
	# Two-tree switch: rewrites only the paths that differ and deletes what $2 lacks. Ignored files stay,
	# unless $2 tracks that very path. --reset overwrites untracked files, but apply checked there are none.
	GIT_INDEX_FILE="$G/boxery-sync-index" git read-tree --reset -u "$1" "$2" || return 1
	# The index holds local HEAD, so `git status` in the VM shows the working changes, as it does locally.
	git read-tree "$HEAD_SHA" || return 1
	git update-index -q --refresh >/dev/null 2>&1
	printf '%s\n' 'option no-deref' "update HEAD $HEAD_SHA" "update refs/boxery/synced $SNAP" "update refs/boxery/base $HEAD_SHA" \
		'delete refs/boxery/incoming' | git update-ref -m "boxery sync" --stdin || return 1
}

apply() {
	: "${FORMAT:?}" "${SNAP:?}" "${HEAD_SHA:?}" "${BUNDLE?}" "${EXPECT_SYNCED?}" "${EXPECT_HEAD?}"
	# Past this point the caller has committed: finish or roll back, even if it cancels or disconnects.
	trap '' INT TERM HUP PIPE
	[ -z "$BUNDLE" ] || trap 'rm -f "$BUNDLE"' EXIT
	mkdir -p "$DIR" && cd "$DIR" || die "cannot create $DIR"
	if ! is_repo_root; then
		[ -z "$(ls -A)" ] || refuse "$DIR is not a git repository and is not empty"
		git init -q --object-format="$FORMAT" || die "git init failed in $DIR"
	fi
	setup_git
	exec 9>"$G/boxery-sync.lock"
	if command -v flock >/dev/null; then flock -w 60 9 || refuse "another sync into $DIR is running"; fi
	recover
	[ "$(rev refs/boxery/synced)" = "$EXPECT_SYNCED" ] && [ "$(rev HEAD)" = "$EXPECT_HEAD" ] ||
		refuse "the checkout in $DIR changed during the sync; run it again"
	local b w new prev lock=0
	b=$(baseline)
	w=$(wt "$b") || die "cannot read the working directory of $DIR"
	[ "$w" = "$b" ] || refuse "uncommitted changes appeared in $DIR during the sync; run it again"
	if [ -n "$BUNDLE" ]; then
		git bundle verify -q "$BUNDLE" >/dev/null 2>&1 || die "the bundle doesn't apply to the VM's repository"
		git fetch -q --no-tags --no-write-fetch-head "$BUNDLE" "+refs/heads/sync:refs/boxery/incoming" || die "git fetch from the bundle failed"
		rm -f "$BUNDLE"
	fi
	git cat-file -e "$SNAP^{commit}" 2>/dev/null || die "the VM lacks commit $SNAP after the transfer"
	new=$(git rev-parse "$SNAP^{tree}") || die "cannot read $SNAP"
	prev=$(rev refs/boxery/synced); [ -n "$prev" ] || prev=$(rev HEAD)
	git diff --quiet "${prev:-$EMPTY}" "$SNAP" -- "${LOCKFILES[@]}" || lock=1
	rm -f "$G/boxery-sync-index.bak"
	[ ! -f "$IDX" ] || cp "$IDX" "$G/boxery-sync-index.bak" || die "cannot back up the index"
	printf '%s %s\n' "$b" "$new" >"$G/boxery-sync-pending" || die "cannot write $G/boxery-sync-pending"
	if ! swap "$b" "$new"; then
		rollback "$b" "$new" || die "the sync failed and the checkout in $DIR could not be restored; see $G/boxery-sync-pending"
		die "the sync failed; the checkout in $DIR was restored"
	fi
	rm -f "$G/boxery-sync-pending" "$G/boxery-sync-index" "$G/boxery-sync-index.bak"
	echo "lockfile_changed=$lock"
	wt "$new" | sed '1s/^/tree=/' || die "synced, but cannot read the working directory of $DIR back"
}

case "$MODE" in
probe) probe ;;
apply) apply ;;
*) die "unknown mode $MODE" ;;
esac
