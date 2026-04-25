#!/usr/bin/env bash
printf '\033[2J\033[H'
printf 'Mini TUI\r\n'
printf 'Command: '
IFS= read -r line
case "$line" in
  quit) printf '\r\nbye\r\n'; exit 0 ;;
  *) printf '\r\nyou typed:%s\r\n' "$line"; exit 0 ;;
esac
