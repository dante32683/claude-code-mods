# bash-fixes: sourced before each of Claude's Bash commands. Functions, not
# exported, so they cover the command line Claude wrote and not the scripts
# and programs it starts. Only Git Bash (MSYS) needs them.
[[ $OSTYPE == msys* || $OSTYPE == cygwin* ]] || return 0

# rg is a native Windows program, so Git Bash rewrites any argument that
# starts with / into a Windows path first: the pattern "/api/v1" becomes
# "C:/Program Files/Git/api/v1" and the search silently finds nothing. Turn
# that rewriting off and convert only arguments that name an existing path.
rg() {
  local args=() a
  for a in "$@"; do
    if [[ $a == /?* && -e $a ]]; then
      args+=("$(cygpath -m -- "$a")")
    else
      args+=("$a")
    fi
  done
  MSYS2_ARG_CONV_EXCL='*' command rg "${args[@]}"
}

# adb is native too, so the same rewriting turns phone paths like /sdcard/x
# into C:/Program Files/Git/sdcard/x. Turn it off. Only push, pull, and the
# install commands take laptop paths, so only theirs are converted, and only
# when they exist here; `adb shell ls /tmp` keeps the phone's /tmp.
adb() {
  local args=() a sub='' local_paths='' skip=''
  for a in "$@"; do
    if [[ -n $skip ]]; then
      skip=''
    elif [[ -z $sub && $a == -[stHPL] ]]; then
      skip=1 # global options that take a value: -s serial, -t id, -H host, -P port, -L socket
    elif [[ -z $sub && $a != -* ]]; then
      sub=$a
      case $sub in push | pull | install | install-multiple | install-multi-package | sideload) local_paths=1 ;; esac
    fi
    if [[ -n $local_paths && $a == /?* && -e $a ]]; then
      args+=("$(cygpath -m -- "$a")")
    else
      args+=("$a")
    fi
  done
  MSYS2_ARG_CONV_EXCL='*' command adb "${args[@]}"
}

# gh is native too. In `gh api` the rewriting turns the endpoint /repos/x into
# C:/Program Files/Git/repos/x ("invalid API endpoint") and field values like
# -f path=/docs into Windows paths. For `gh api` only, turn it off and convert
# only local files that exist: an --input file or a -F key=@file value. Other
# gh commands keep the default rewriting, since their / arguments are local
# paths, some not made yet (gh repo clone x /c/new).
gh() {
  if [[ ${1-} != api ]]; then
    command gh "$@"
    return
  fi
  local args=() a
  for a in "$@"; do
    if [[ $a == /?* && -e $a ]]; then
      a=$(cygpath -m -- "$a")
    elif [[ $a == ?*=@/?* && -e ${a#*=@} ]]; then
      a="${a%%=@*}=@$(cygpath -m -- "${a#*=@}")"
    fi
    args+=("$a")
  done
  MSYS2_ARG_CONV_EXCL='*' command gh "${args[@]}"
}

# sed -i exits 0 even when its script matched nothing. With -i, fail when
# none of the files it was given changed.
sed() {
  local inplace='' skip='' a before
  local files=()
  for a in "$@"; do
    if [[ -n $skip ]]; then skip=''; continue; fi
    case $a in
      -i* | --in-place*) inplace=1 ;;
      -e | -f | -l | --expression | --file | --line-length) skip=1 ;;
      --*) ;;
      -*i*) inplace=1 ;;
      -*[ef]) skip=1 ;;
      -*) ;;
      *) [[ -f $a ]] && files+=("$a") ;;
    esac
  done
  if [[ -z $inplace || ${#files[@]} -eq 0 ]]; then
    command sed "$@"
    return
  fi
  before=$(md5sum -- "${files[@]}")
  command sed "$@" || return
  [[ $(md5sum -- "${files[@]}") != "$before" ]] && return 0
  echo "sed: the script matched nothing; no change in ${files[*]}" >&2
  # A \n in the script only matches with -z: sed reads one line at a time.
  [[ $* == *'\n'* ]] && echo "sed: it reads one line at a time, so a \\n in a pattern never matches; use edits for text over several lines" >&2
  return 1
}

# edits: exact-text edits from a quoted heredoc, all or nothing, keeping each
# file's line endings. Usage and format: bin/edits.py (edits --help).
edits() {
  python "$(dirname -- "${BASH_SOURCE[0]}")/../bin/edits.py" "$@"
}
