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
  return 1
}
