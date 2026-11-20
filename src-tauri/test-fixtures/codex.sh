while IFS= read -r request; do
    printf '%s\n' "$request" >> "$FAKE_LOG"
    case "$request" in
        *'"method":"initialize"'*) echo '{"id":1,"result":{}}';;
        *'"method":"account/read"'*) echo '{"id":2,"result":{"account":{"type":"chatgpt"}}}';;
        *'"method":"config/read"'*) echo '{"id":3,"result":{"config":{"model_provider":"openai"},"layers":[]}}';;
        *'"method":"thread/start"'*|*'"method":"thread/resume"'*)
            case "$request" in
                *'"ephemeral":true'*)
                    title_mode=1
                    echo '{"id":4,"result":{"thread":{"id":"title-thread"}}}'
                    continue;;
            esac
            if [ "$FAKE_RESUME" = missing ]; then
                echo '{"id":4,"error":{"code":-1,"message":"разговор отсутствует"}}'
                continue
            fi
            if [ "$FAKE_RESUME" = mismatch ]; then
                echo '{"id":4,"result":{"thread":{"id":"different"}}}'
                continue
            fi
            if [ "$FAKE_MODE" = title_metadata ]; then
                echo '{"id":4,"result":{"thread":{"id":"native-thread","name":"Название из Codex"},"model":"chosen","reasoningEffort":"high","serviceTier":"priority"}}'
            else
                echo '{"id":4,"result":{"thread":{"id":"native-thread"},"model":"chosen","reasoningEffort":"high","serviceTier":"priority"}}'
            fi
            if [ "$FAKE_MODE" = title_event ]; then
                echo '{"method":"thread/name/updated","params":{"threadId":"different-thread","threadName":"Чужое название"}}'
                echo '{"method":"thread/name/updated","params":{"threadId":"native-thread","threadName":"  "}}'
                echo '{"method":"thread/name/updated","params":{"threadId":"native-thread","threadName":null}}'
                echo '{"method":"thread/name/updated","params":{"threadId":"native-thread","threadName":"Название из Codex"}}'
                echo '{"method":"thread/name/updated","params":{"threadId":"native-thread","threadName":"Повторное название"}}'
            fi
            if [ "$FAKE_MODE" = elicitation_before_turn ]; then
                echo '{"id":"foreign-thread","method":"mcpServer/elicitation/request","params":{"threadId":"different-thread","turnId":null}}'
                echo '{"id":"foreign-turn","method":"mcpServer/elicitation/request","params":{"threadId":"native-thread","turnId":"different-turn"}}'
                echo '{"id":"missing-turn","method":"item/commandExecution/requestApproval","params":{"threadId":"native-thread","turnId":null}}'
                echo '{"id":"approval","method":"mcpServer/elicitation/request","params":{"threadId":"native-thread","turnId":null,"serverName":"test","mode":"form","message":"Подтверждение запуска"}}'
            fi;;
        *'"method":"turn/start"'*)
            if [ "$title_mode" = 1 ]; then
                echo '{"id":5,"result":{"turn":{"id":"title-turn"}}}'
                if [ "$FAKE_MODE" = title_wait ]; then
                    while [ ! -e "$FAKE_FINISH" ]; do /bin/sleep 0.02; done
                fi
                if [ "$FAKE_MODE" = title_failure ]; then
                    echo '{"method":"turn/completed","params":{"threadId":"title-thread","turn":{"id":"title-turn","status":"failed","error":{"message":"отказ"}}}}'
                else
                    echo '{"method":"item/completed","params":{"threadId":"other-thread","turnId":"title-turn","item":{"type":"agentMessage","text":"Чужое название"}}}'
                    echo '{"method":"item/completed","params":{"threadId":"title-thread","turnId":"title-turn","item":{"type":"agentMessage","text":"Краткое название разговора"}}}'
                    echo '{"method":"turn/completed","params":{"threadId":"title-thread","turn":{"id":"title-turn","status":"completed","error":null}}}'
                fi
                continue
            fi
            if [ "$FAKE_MODE" = elicitation_before_turn ]; then continue; fi
            echo '{"method":"turn/started","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"inProgress"}}}'
            echo '{"id":5,"result":{"turn":{"id":"native-turn","status":"inProgress"}}}'
            echo '{"method":"item/agentMessage/delta","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"message-1","delta":"при"}}'
            echo '{"method":"item/started","params":{"threadId":"native-thread","turnId":"native-turn","item":{"id":"command-1","type":"commandExecution","command":"pwd","status":"inProgress"}}}'
            if [ "$FAKE_MODE" = disconnect ]; then exit 3; fi
            if [ "$FAKE_MODE" = malformed ]; then echo broken; continue; fi
            if [ "$FAKE_MODE" = wait ]; then
                echo '{"id":"approval","method":"item/commandExecution/requestApproval","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"command-1","command":"pwd"}}'
                continue
            fi
            case "$FAKE_MODE" in
                input)
                    echo '{"id":"approval","method":"item/tool/requestUserInput","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"input-1","isBlocking":false,"questions":[{"id":"q","question":"Выбор"}]}}'
                    continue;;
                async_input)
                    echo '{"method":"item/completed","params":{"threadId":"native-thread","turnId":"native-turn","item":{"id":"question-1","type":"agentMessage","text":"Что хочешь сделать дальше?","delivery":"async","questions":[{"title":"Что хочешь сделать дальше?","options":null},{"title":"Как проверить?","options":["Тесты","Вручную"]}]}}}';;
                permissions)
                    echo '{"id":"approval","method":"item/permissions/requestApproval","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"permission-1","permissions":{"fileSystem":{"write":["/tmp/allowed"]}}}}'
                    continue;;
                elicitation)
                    echo '{"id":"approval","method":"mcpServer/elicitation/request","params":{"threadId":"native-thread","turnId":null,"serverName":"test","mode":"form","message":"Подтверждение"}}'
                    continue;;
                foreign)
                    echo '{"id":"foreign","method":"item/commandExecution/requestApproval","params":{"threadId":"different-thread","turnId":"native-turn"}}';;
            esac
            if [ "$FAKE_MODE" = resolved ]; then
                echo '{"id":"approval","method":"item/fileChange/requestApproval","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"file-1"}}'
                echo '{"method":"serverRequest/resolved","params":{"threadId":"native-thread","requestId":"approval"}}'
                continue
            fi
            if [ "$FAKE_MODE" = hold ]; then continue; fi
            echo '{"method":"item/commandExecution/outputDelta","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"command-1","delta":"output"}}'
            echo '{"method":"item/completed","params":{"threadId":"native-thread","turnId":"native-turn","item":{"id":"command-1","type":"commandExecution","status":"completed"}}}'
            echo '{"method":"item/agentMessage/delta","params":{"threadId":"native-thread","turnId":"native-turn","itemId":"message-1","delta":"вет"}}'
            echo '{"method":"item/completed","params":{"threadId":"native-thread","turnId":"native-turn","item":{"id":"message-1","type":"agentMessage","text":"привет"}}}'
            case "$FAKE_MODE" in
                failure) echo '{"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"failed","error":{"message":"отказ"}}}}';;
                completed_with_error) echo '{"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"completed","error":{"message":"отказ"}}}}';;
                *) echo '{"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"completed","error":null}}}';;
            esac;;
        *'"id":"approval"'*'"result":'*)
            if [ "$FAKE_MODE" = elicitation_before_turn ]; then
                echo '{"method":"turn/started","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"inProgress"}}}'
                echo '{"id":5,"result":{"turn":{"id":"native-turn","status":"inProgress"}}}'
            fi
            echo '{"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"completed","error":null}}}';;
        *'"method":"turn/interrupt"'*)
            echo '{"id":6,"result":{}}'
            while [ ! -e "$FAKE_FINISH" ]; do /bin/sleep 0.02; done
            echo '{"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","status":"interrupted","error":null}}}';;
    esac
done
