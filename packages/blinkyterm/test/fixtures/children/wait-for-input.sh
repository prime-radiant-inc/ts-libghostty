#!/usr/bin/env bash
printf 'ready\r\n'
IFS= read -r line
printf 'input:%s\r\n' "$line"
