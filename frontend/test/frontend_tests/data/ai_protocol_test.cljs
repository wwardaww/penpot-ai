;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-protocol-test
  (:require
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [cljs.test :as t :include-macros true]))

(defn- json
  [data]
  (js/JSON.stringify (clj->js data)))

(t/deftest decode-reads-camel-case-daemon-messages
  (let [msg (proto/decode (json {"type" "chat.delta" "conversationId" "c1"
                                 "messageId" "m1" "text" "Hi"}))]
    (t/is (= {:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hi"} msg))))

(t/deftest decode-rejects-unknown-or-malformed-messages
  (t/testing "unknown type"
    (t/is (nil? (proto/decode (json {"type" "chat.unknown"})))))
  (t/testing "missing required field"
    (t/is (nil? (proto/decode (json {"type" "chat.delta" "conversationId" "c1"})))))
  (t/testing "bad enum value"
    (t/is (nil? (proto/decode (json {"type" "permission.request" "requestId" "r" "title" "t"
                                     "description" "d" "risk" "extreme"})))))
  (t/testing "not json"
    (t/is (nil? (proto/decode "not json")))))

(t/deftest decode-keeps-workflow-payloads
  (let [msg (proto/decode (json {"type" "workflow.event" "runId" "r1" "kind" "question"
                                 "payload" {"questionId" "q1" "text" "Pick"
                                            "options" [{"id" "a" "label" "A"}]}}))]
    (t/is (= "question" (:kind msg)))
    (t/is (= "q1" (get-in msg [:payload :question-id])))
    (t/is (= [{:id "a" :label "A"}] (get-in msg [:payload :options])))))

(t/deftest decode-accepts-every-daemon-message-type
  (doseq [data [{"type" "auth.ok" "daemonVersion" "0.1.0"}
                {"type" "auth.error" "reason" "bad token"}
                {"type" "chat.tool" "conversationId" "c" "toolName" "x" "summary" "s" "status" "running"}
                {"type" "chat.done" "conversationId" "c" "messageId" "m" "usage" {"inputTokens" 3}}
                {"type" "chat.history" "rid" "r" "conversationId" "c"
                 "messages" [{"role" "user" "messageId" "m" "text" "t" "ts" "2026-11-17T00:00:00Z"}]}
                {"type" "permission.request" "requestId" "r" "title" "t" "description" "d" "risk" "low"}
                {"type" "workflow.started" "rid" "r" "runId" "u" "name" "chat"}
                {"type" "workflow.done" "runId" "u" "ok" true "summary" "done"}
                {"type" "preview.ready" "projectId" "p" "url" "http://localhost:5200"}
                {"type" "preview.stopped" "projectId" "p" "url" "http://localhost:5200"}
                {"type" "error" "rid" "r" "code" "busy" "message" "busy"}]]
    (t/is (some? (proto/decode (json data))) (get data "type"))))

(t/deftest encode-writes-camel-case-keys
  (let [encoded (proto/encode (proto/chat-send {:rid "r1"
                                                :conversation-id "c1"
                                                :text "Hello"
                                                :attachments [{:kind "node" :file-id "f" :page-id "p"
                                                               :node-id "n" :name "Card" :type "frame"}]}))
        data    (js->clj (js/JSON.parse encoded))]
    (t/is (= "chat.send" (get data "type")))
    (t/is (= "c1" (get data "conversationId")))
    (t/is (= "n" (get-in data ["attachments" 0 "nodeId"])))))

(t/deftest constructors-build-valid-client-messages
  (t/is (proto/valid-client-message? (proto/auth "token")))
  (t/is (proto/valid-client-message? (proto/chat-send {:conversation-id "c" :text "hi"})))
  (t/is (proto/valid-client-message? (proto/chat-cancel "c")))
  (t/is (proto/valid-client-message? (proto/chat-history {:conversation-id "c"})))
  (t/is (proto/valid-client-message? (proto/permission-respond {:request-id "r" :allow true :remember true})))
  (t/is (proto/valid-client-message? (proto/workflow-run {:name "auto-name" :params {:node-ids ["a"]}})))
  (t/is (proto/valid-client-message? (proto/workflow-answer {:run-id "r" :question-id "q" :option-id "o"})))
  (t/is (proto/valid-client-message? (proto/workflow-cancel "r")))
  (t/is (proto/valid-client-message? (proto/preview-start "p")))
  (t/is (proto/valid-client-message? (proto/context-set {:file-id "f" :file-name "File" :project-id "p"
                                                         :team-id "t" :page-id "pg"
                                                         :persona :developer :platform :mobile
                                                         :mcp-session-id "s" :project-name "Proj"}))))

(t/deftest context-set-defaults-persona-and-platform
  (let [msg (proto/context-set {:file-id "f" :project-id "p" :team-id "t" :page-id "pg"})]
    (t/is (= "designer" (:persona msg)))
    (t/is (= "web" (:platform msg)))
    (t/is (not (contains? msg :mcp-session-id)))))

(t/deftest answer-params-reach-the-daemon-in-camel-case
  (let [encoded (proto/encode (proto/workflow-answer {:run-id "r" :question-id "q" :option-id "o"}))
        data    (js->clj (js/JSON.parse encoded))]
    (t/is (= {"runId" "r" "questionId" "q" "optionId" "o"} (get data "params")))
    (t/is (= "answer" (get data "name")))))

(t/deftest parse-pair-input-reads-links-and-tokens
  (t/is (= "abc123" (client/parse-pair-input "https://localhost:3449/#/penforge/pair?token=abc123")))
  (t/is (= "a b" (client/parse-pair-input "https://x/?screen=penforge-pair&token=a%20b")))
  (t/is (= "abc-123_x" (client/parse-pair-input "  abc-123_x  ")))
  (t/is (nil? (client/parse-pair-input "")))
  (t/is (nil? (client/parse-pair-input "not a token!"))))

(t/deftest reconnect-delay-grows-and-caps
  (t/is (= 1000 (client/get-reconnect-delay 0)))
  (t/is (= 4000 (client/get-reconnect-delay 2)))
  (t/is (= 30000 (client/get-reconnect-delay 10))))

(t/deftest context-reads-persona-platform-and-mcp-session
  (let [file-id    (random-uuid)
        page-id    (random-uuid)
        project-id (random-uuid)
        team-id    (random-uuid)
        state      {:current-file-id file-id
                    :current-page-id page-id
                    :current-project-id project-id
                    :current-team-id team-id
                    :files {file-id {:name "Shop"}}
                    :projects {project-id {:name "Store"}}
                    :profile {:props {:penforge-persona "developer"}}
                    :penforge-project-settings {project-id :mobile}
                    :mcp {:session-id "s1"}}
        context    (client/get-context state)]
    (t/is (= :developer (:persona context)))
    (t/is (= :mobile (:platform context)))
    (t/is (= "s1" (:mcp-session-id context)))
    (t/is (= "Store" (:project-name context)))
    (t/is (nil? (client/get-context (dissoc state :current-page-id))))
    (t/is (= :designer (client/get-persona {})))
    (t/is (= :web (client/get-platform {})))))
