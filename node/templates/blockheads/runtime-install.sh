#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export TZ=Etc/UTC

ln -fs /usr/share/zoneinfo/Etc/UTC /etc/localtime
echo 'Etc/UTC' >/etc/timezone

BINARY="blockheads_server171"

declare -A LIB_SEARCH=(
  ["libgnustep-base.so"]="libgnustep-base"
  ["libobjc.so"]="libobjc"
  ["libgnutls.so"]="libgnutls"
  ["libgcrypt.so"]="libgcrypt"
  ["libffi.so"]="libffi"
  ["libicui18n.so"]="libicu"
  ["libicuuc.so"]="libicu"
  ["libicudata.so"]="libicu"
  ["libdispatch.so"]="libdispatch"
)

find_pkg_candidate() {
  local search_term="$1"
  apt-cache search "$search_term" 2>/dev/null \
    | awk '{print $1}' \
    | grep -E "^${search_term}" \
    | grep -v -e 'dbg' -e 'doc' \
    | head -n1 || true
}

find_highest_version_lib() {
  local base="$1"
  local dirs=(
    "/usr/lib"
    "/usr/lib/x86_64-linux-gnu"
    "/lib"
    "/lib/x86_64-linux-gnu"
    "/usr/local/lib"
  )
  local candidates=()

  for d in "${dirs[@]}"; do
    if [ -d "$d" ]; then
      while IFS= read -r file; do
        local filename
        filename="$(basename "$file")"
        if [[ "$filename" == "$base"* ]]; then
          candidates+=("$filename")
        fi
      done < <(find "$d" -maxdepth 1 -type f -name "$base*" 2>/dev/null || true)
    fi
  done

  if [ ${#candidates[@]} -eq 0 ]; then
    echo ""
    return
  fi

  IFS=$'\n' read -r -d '' -a sorted < <(
    for f in "${candidates[@]}"; do
      ver="${f#$base}"
      ver="${ver#.}"
      [ -z "$ver" ] && ver="0"
      echo "$ver $f"
    done | sort -rV && printf '\0'
  )

  echo "${sorted[0]#* }"
}

build_libdispatch() {
  local dir
  dir="$(pwd)"

  rm -rf swift-corelibs-libdispatch
  git clone --depth 1 https://github.com/swiftlang/swift-corelibs-libdispatch.git swift-corelibs-libdispatch
  mkdir -p swift-corelibs-libdispatch/build
  cd swift-corelibs-libdispatch/build
  cmake -G Ninja -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ ..
  ninja "-j$(nproc)"
  ninja install
  ldconfig || true
  cd "$dir"
}

apt-get update -y
apt-get install -y patchelf tzdata

for libbase in "${!LIB_SEARCH[@]}"; do
  search_term="${LIB_SEARCH[$libbase]}"
  echo "Processing $libbase"

  libfile="$(find_highest_version_lib "$libbase")"

  if [ "$libbase" = "libdispatch.so" ]; then
    if [ -z "$libfile" ]; then
      echo "Skipping $libbase, no library file found"
      continue
    fi
  else
    if [ -z "$libfile" ]; then
      pkg_candidate="$(find_pkg_candidate "$search_term")"
      if [ -n "$pkg_candidate" ]; then
        apt-get install -y "$pkg_candidate" || true
        libfile="$(find_highest_version_lib "$libbase")"
      fi
    fi
  fi

  if [ -z "$libfile" ]; then
    echo "Skipping $libbase, no library file found"
    continue
  fi

  needed_libs="$(patchelf --print-needed "$BINARY" | grep "^$libbase" || true)"
  if [ -z "$needed_libs" ]; then
    continue
  fi

  for oldlib in $needed_libs; do
    echo "Replacing $oldlib with $libfile"
    patchelf --replace-needed "$oldlib" "$libfile" "$BINARY"
  done
done

echo "Runtime patching complete"