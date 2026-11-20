zmodload zsh/datetime
zmodload -F zsh/files b:zf_mv
autoload -Uz add-zle-hook-widget

if (( ${+ZSH_AUTOSUGGEST_ACCEPT_WIDGETS} )); then
  ZSH_AUTOSUGGEST_ACCEPT_WIDGETS+=(expand-or-complete complete-word)
  ZSH_AUTOSUGGEST_IGNORE_WIDGETS+=(_yade_edit)
fi

if (( ! ${+HISTFILE} )); then
  HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history
  SAVEHIST=1000
  (( HISTSIZE < 1000 )) && HISTSIZE=1000
fi

function _yade_preexec() {
  emulate -L zsh
  if (( _yade_submitted )); then
    (( _yade_started )) && return 0
    typeset -g _yade_started=1
    builtin print -rn -- "$(<"$_yade_directory/input")" > "$_yade_directory/command"
  else
    builtin print -rn -- "$1" > "$_yade_directory/command"
  fi
  (( _yade_started_at > 0 )) || typeset -gF _yade_started_at=$EPOCHREALTIME
  command rm -f -- "$_yade_directory/ready"
  builtin printf '\e]777;%s;C;%s\a' "$_yade_token" "$(/usr/bin/base64 < "$_yade_directory/command")"
}

function _yade_precmd() {
  local yade_status=$?
  emulate -L zsh
  local -F yade_duration=0
  (( _yade_started_at > 0 )) && yade_duration=$(( (EPOCHREALTIME - _yade_started_at) * 1000 ))
  typeset -gF _yade_started_at=0
  typeset -g _yade_submitted=0 _yade_started=0
  builtin print -rn -- "$PWD" > "$_yade_directory/cwd"
  builtin print -rn -- "$HOME" > "$_yade_directory/home"
  builtin print -rn -- "$(command git symbolic-ref --quiet --short HEAD 2>/dev/null)" > "$_yade_directory/branch"
  builtin print -rn -- ready > "$_yade_directory/ready"
  builtin printf '\e]777;%s;P;%s;%s\a' "$_yade_token" "$yade_status" "$yade_duration"
}

function _yade_submit() {
  emulate -L zsh
  typeset -g _yade_submitted=1 _yade_started=0
  BUFFER="$(<"$_yade_directory/input")"
  CURSOR=${#BUFFER}
  typeset -gF _yade_started_at=$EPOCHREALTIME
  builtin printf '\e]777;%s;S;%s\a' "$_yade_token" "$(/usr/bin/base64 < "$_yade_directory/input")"
  zle .accept-line
}

function _yade_restore() {
  BUFFER="$(<"$_yade_directory/input")"
  CURSOR=${#BUFFER}
}

function _yade_newline() {
  LBUFFER+=$'\n'
}

function _yade_editor_state() {
  [[ $CONTEXT == start ]] || return 0
  local -a yade_words=( ${(z)BUFFER} )
  local yade_known=0
  if [[ -n $yade_words[1] ]] && builtin whence -w -- "${(Q)yade_words[1]}" >/dev/null 2>&1; then
    yade_known=1
  fi
  local yade_state="${_yade_edit_request:-0}"$'\0'"$BUFFER"$'\0'"$CURSOR"$'\0'"$POSTDISPLAY"$'\0'"$yade_known"$'\0'
  builtin print -rn -- "$yade_state" > "$_yade_directory/editor.pending"
  zf_mv -f -- "$_yade_directory/editor.pending" "$_yade_directory/editor"
}

function _yade_edit() {
  # Ответ редактору должен включать готовую подсказку.
  local ZSH_AUTOSUGGEST_USE_ASYNC
  unset ZSH_AUTOSUGGEST_USE_ASYNC
  local -a yade_fields=("${(@f)$(<"$_yade_directory/edit-request")}")
  typeset -g _yade_edit_request=$yade_fields[1]
  BUFFER="$(<"$_yade_directory/draft")"
  CURSOR=$yade_fields[2]
  case $yade_fields[3] in
    change) POSTDISPLAY=''; (( ${+widgets[autosuggest-fetch]} )) && zle autosuggest-fetch ;;
    complete)
      if [[ -n $POSTDISPLAY && $CURSOR -eq ${#BUFFER} ]] && (( ${+widgets[autosuggest-accept]} )); then
        zle autosuggest-accept
      else
        local -a yade_binding=( ${(z)"$(bindkey -M "$KEYMAP" '^I')"} )
        zle "${(Q)yade_binding[-1]}"
      fi ;;
    previous) zle up-line-or-history ;;
    next) zle down-line-or-history ;;
    accept) (( ${+widgets[autosuggest-accept]} )) && zle autosuggest-accept ;;
  esac
  _yade_editor_state
  return 0
}

function _yade_accept_line() {
  if [[ $CONTEXT == start && -n $BUFFER ]]; then
    typeset -g _yade_submitted=1 _yade_started=0
    builtin print -rn -- "$BUFFER" > "$_yade_directory/input"
    builtin printf '\e]777;%s;S;%s\a' "$_yade_token" "$(/usr/bin/base64 < "$_yade_directory/input")"
  elif [[ $CONTEXT != start && $_yade_submitted == 1 ]]; then
    builtin print -rn -- $'\n'"$BUFFER" >> "$_yade_directory/input"
  fi
  zle .accept-line
}

function _yade_line_init() {
  if [[ $CONTEXT == start ]]; then
    PROMPT='' RPROMPT=''
    zle .reset-prompt
    _yade_input_ready
  fi
  return 0
}

zle -N _yade_submit
zle -N _yade_restore
zle -N _yade_newline
zle -N _yade_edit
zle -N accept-line _yade_accept_line
for _yade_keymap in emacs viins vicmd; do
  bindkey -M $_yade_keymap '\e[99~' _yade_submit
  bindkey -M $_yade_keymap '\e[98~' _yade_restore
  bindkey -M $_yade_keymap '\e[13;2u' _yade_newline
  bindkey -M $_yade_keymap '\e[97~' _yade_edit
done
unset _yade_keymap
preexec_functions=(_yade_preexec ${preexec_functions:#_yade_preexec})
precmd_functions=(_yade_precmd ${precmd_functions:#_yade_precmd})
add-zle-hook-widget line-init _yade_line_init
