#!/usr/bin/env bash
# 发布到 GitHub：推送代码；如果 manifest.json 里的版本号还没发布过，
# 就打包插件并创建 GitHub Release（附可直接安装的 zip）。
# 用法：bash scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "还有未提交的改动，请先提交再发布：" >&2
  git status --short >&2
  exit 1
fi

version=$(node -p "require('./manifest.json').version")
tag="v$version"

git push origin HEAD

if gh release view "$tag" >/dev/null 2>&1; then
  echo "代码已推送；$tag 之前已经发布过，没有新建 Release（要发新版本请先改 manifest.json 的 version）"
  exit 0
fi

# git archive 只打包已提交的文件，.gitattributes 里标了 export-ignore 的开发文件不会进 zip
zipfile="$(mktemp -d)/youxuan-ai-$tag.zip"
git archive --format=zip -o "$zipfile" HEAD
gh release create "$tag" "$zipfile" --title "优选AI $tag" --generate-notes
echo "已发布 $tag"
