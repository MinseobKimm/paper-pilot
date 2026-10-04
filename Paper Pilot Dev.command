#!/bin/zsh

# Finder에서 실행할 때도 Homebrew와 Rust 도구를 찾을 수 있게 합니다.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
terminal_window_id=""
if [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" ]]; then
  terminal_window_id=$(/usr/bin/osascript -e 'tell application "Terminal" to get id of front window' 2>/dev/null)
fi

close_launcher_window() {
  if [[ "$terminal_window_id" == <-> ]]; then
    # 셸이 종료된 다음 이 실행기에 속한 터미널 창만 닫습니다.
    /usr/bin/nohup /usr/bin/osascript -e 'delay 1' \
      -e "tell application \"Terminal\" to close (first window whose id is $terminal_window_id)" \
      </dev/null >/dev/null 2>&1 &
  fi
}

dev_app_is_running() {
  local app_pid
  for app_pid in $(/usr/bin/pgrep -x paper-pilot 2>/dev/null); do
    if /bin/ps -p "$app_pid" -o command= 2>/dev/null | /usr/bin/grep -Fq 'target/debug/paper-pilot'; then
      return 0
    fi
  done
  return 1
}

chatgpt_codex="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
if [[ -z "$CODEX_BIN" && -x "$chatgpt_codex" ]]; then
  export CODEX_BIN="$chatgpt_codex"
fi
cd "${0:A:h}" || exit 1

if ! command -v npm >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  print 'npm과 Rust(cargo)가 필요합니다. README의 설치 안내를 확인하세요.'
  read '?Enter를 누르면 종료합니다. '
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm ci || exit $?
fi

if dev_app_is_running; then
  close_launcher_window
  exit 0
fi

run_dir="$PWD/.dev-run"
pid_file="$run_dir/dev.pid"
log_file="$run_dir/dev.log"
mkdir -p "$run_dir" || exit 1

server_pid=""
if [[ -f "$pid_file" ]]; then
  read -r saved_pid < "$pid_file"
  if [[ "$saved_pid" == <-> ]] && kill -0 "$saved_pid" 2>/dev/null &&
      /bin/ps -p "$saved_pid" -o command= 2>/dev/null | /usr/bin/grep -Fq 'npm run tauri:dev'; then
    server_pid="$saved_pid"
  fi
fi

if [[ -z "$server_pid" ]]; then
  /usr/bin/nohup npm run tauri:dev </dev/null >"$log_file" 2>&1 &
  server_pid=$!
  print -r -- "$server_pid" > "$pid_file"
fi

app_ready=false
for (( attempt = 0; attempt < 180; attempt++ )); do
  if dev_app_is_running; then
    app_ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$app_ready" == true ]]; then
  close_launcher_window
  exit 0
fi

print "Paper Pilot을 열지 못했습니다. 로그: $log_file"
tail -n 20 "$log_file"
read '?Enter를 누르면 종료합니다. '
exit 1
