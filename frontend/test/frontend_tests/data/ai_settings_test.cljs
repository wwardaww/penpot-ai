;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-settings-test
  "AI settings: daemon replies, the daemon's own answers in the chat and
  the result of testing the Claude command."
  (:require
   ["react-dom/server" :as rds]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.ai.settings :as settings]
   [app.main.ui.settings.ai :as page]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.main.ui.workspace.ai.design-md.state :as design-md]
   [app.main.ui.workspace.ai.permission-mode :as mode]
   [app.main.ui.workspace.ai.qa.events :as qa]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(defn- json
  [data]
  (js/JSON.stringify (clj->js data)))

(defn- settings-of
  [state]
  (get-in state [:penforge :settings]))

(def ^:private loaded
  (settings/apply-message {} {:type "settings"
                              :scope "machine"
                              :permission-mode "manual"
                              :claude-command "claude"}))

(defn- update-state
  [state event]
  (ptk/update event state))

;; --- Protocol

(t/deftest requests-follow-the-protocol
  (doseq [message [(proto/settings-get)
                   (proto/settings-set {:permission-mode :auto})
                   (proto/settings-set {:claude-command "claude-local"})
                   (proto/settings-test "claude")]]
    (t/is (proto/valid-client-message? message))
    (t/is (proto/dialog-rid? (:rid message)) "its errors stay out of the chat"))
  (t/is (= {"type" "settings.set" "permissionMode" "auto"}
           (-> (proto/settings-set {:permission-mode :auto})
               (proto/encode)
               (js/JSON.parse)
               (js->clj)
               (dissoc "rid")))))

(t/deftest daemon-messages-are-decoded
  (t/is (= {:type "settings" :scope "session" :permission-mode "auto"}
           (proto/decode (json {:type "settings" :scope "session" :permissionMode "auto"}))))
  (t/is (some? (proto/decode (json {:type "settings.tested" :rid "r" :claudeCommand "claude"
                                    :found false :problem "not-found"}))))
  (t/is (= {:type "permission.answered" :request-id "p1" :allow true :auto true}
           (proto/decode (json {:type "permission.answered" :requestId "p1" :allow true :auto true})))))

;; --- Settings

(t/deftest settings-fill-the-state
  (t/is (= {:scope :machine :permission-mode :manual :claude-command "claude"}
           (settings-of loaded)))
  (t/is (= {:scope :session :permission-mode :auto :claude-command nil}
           (-> (settings/apply-message loaded {:type "settings" :scope "session" :permission-mode "auto"})
               (settings-of)))
        "a daemon that hides the command clears it"))

(t/deftest saving-waits-for-its-own-reply
  (with-redefs [client/send! (constantly true)]
    (let [state (update-state loaded (settings/save-claude-command "claude-local"))
          rid   (get-in (settings-of state) [:save :rid])
          reply {:type "settings" :scope "machine" :permission-mode "manual" :claude-command "claude-local"}]
      (t/is (= :pending (get-in (settings-of state) [:save :status])))
      (t/is (= :pending (-> (settings/apply-message state reply) settings-of :save :status))
            "another tab's change is not the reply")
      (t/is (= {:status :saved}
               (-> (settings/apply-message state (assoc reply :rid rid)) settings-of :save)))
      (t/is (= {:status :failed :rid rid :error {:code "bad-request" :reason "claude-command"}}
               (-> (settings/apply-message state {:type "error" :rid rid :code "bad-request"
                                                  :reason "claude-command" :message "x"})
                   settings-of
                   :save)))
      (t/is (= state (settings/apply-message state {:type "error" :rid "other" :code "busy" :message "x"})))
      (t/is (nil? (-> (update-state state (settings/clear-results)) settings-of :save))))))

(t/deftest saving-fails-without-the-daemon
  (with-redefs [client/send! (constantly false)]
    (t/is (= {:status :failed :error {:code "not-connected"}}
             (-> (update-state loaded (settings/save-claude-command "x")) settings-of :save)))
    (t/is (= {:status :failed :error {:code "not-connected"}}
             (-> (update-state loaded (settings/check-claude-command "x")) settings-of :test)))))

(t/deftest testing-a-command-reports-what-was-found
  (with-redefs [client/send! (constantly true)]
    (let [state  (update-state loaded (settings/check-claude-command "claude-local"))
          rid    (get-in (settings-of state) [:test :rid])
          tested {:type "settings.tested" :rid rid :claude-command "claude-local" :found true
                  :kind "alias" :version "2.1.0"}
          result (:test (settings-of (settings/apply-message state tested)))]
      (t/is (= {:status :done :claude-command "claude-local" :found true :kind "alias" :version "2.1.0"}
               result))
      (t/is (= :success (:level (page/test-result result))))
      (t/is (= state (settings/apply-message state (assoc tested :rid "older"))))))
  (t/is (nil? (page/test-result nil)))
  (t/is (nil? (page/test-result {:status :pending})))
  (doseq [problem ["not-found" "not-started" "timeout" "failed"]]
    (t/is (= :error (:level (page/test-result {:status :done :found (not= problem "not-found")
                                               :claude-command "x" :problem problem})))
          problem))
  (t/is (= :error (:level (page/test-result {:status :failed :error {:code "not-connected"}})))))

;; --- Answers of the daemon (mode auto)

(defn- chat-state
  [& messages]
  {:penforge {:chat (reduce chat/apply-message
                            (assoc chat/empty-chat :status :streaming)
                            messages)}})

(def ^:private permission
  {:type "permission.request" :request-id "p1" :title "Allow?" :description "npm install" :risk "medium"})

(t/deftest automatic-permissions-stay-in-the-timeline
  (let [state  (chat-state permission)
        answer (fn [allow]
                 (settings/apply-message state {:type "permission.answered" :request-id "p1"
                                                :allow allow :auto true}))
        entry  (fn [state] (first (get-in state [:penforge :chat :entries])))]
    (t/is (chat/waiting? (get-in state [:penforge :chat])))
    (t/is (= {:kind :permission :answer :allowed :auto true :description "npm install"}
             (select-keys (entry (answer true)) [:kind :answer :auto :description])))
    (t/is (= :denied (:answer (entry (answer false)))))
    (t/is (not (chat/waiting? (get-in (answer true) [:penforge :chat]))))
    (t/is (= {} (settings/apply-message {} {:type "permission.answered" :request-id "p1" :allow true}))
          "without a chat nothing happens")))

(t/deftest automatic-question-answers-stay-in-the-timeline
  (let [question {:type "workflow.event" :run-id "r1" :kind "question"
                  :payload {:question-id "q1" :text "Pick" :options [{:id "a" :label "A"}]}}
        answered {:type "workflow.event" :run-id "r1" :kind "answered"
                  :payload {:question-id "q1" :option-id "a" :auto true}}
        state    {:penforge {:chat (-> (assoc-in chat/empty-chat [:runs "r1"] {:run-id "r1" :status :running})
                                       (chat/apply-message question)
                                       (chat/apply-message answered))}}
        chat     (get-in (settings/apply-message state answered) [:penforge :chat])]
    (t/is (= {:kind :question :answer "a" :auto true}
             (select-keys (last (:entries chat)) [:kind :answer :auto])))
    (t/is (not (chat/waiting? chat)))))

(t/deftest panels-drop-a-question-the-daemon-answered
  (let [message {:type "workflow.event" :run-id "r1" :kind "answered"
                 :payload {:question-id "q1" :option-id "a" :auto true}}]
    (t/is (nil? (:question (qa/apply-run-message {:question {:question-id "q1"}} message))))
    (t/is (nil? (:question (build/apply-message {:question {:question-id "q1"}} message))))
    (t/is (nil? (get-in (design-md/apply-message {:op {:question {:question-id "q1"}}} "design-md-import" message)
                        [:op :question])))))

;; --- Mode switch

(defn- render-switch
  [state]
  (with-redefs [settings/ref:settings  (atom (settings-of state))
                settings/ref:connected (atom (= :connected (get-in state [:penforge :connection :status])))]
    (rds/renderToStaticMarkup (mf/element mode/permission-mode-switch* #js {:className "chat"}))))

(t/deftest the-switch-shows-the-mode
  (t/is (= "" (render-switch {})) "hidden until the daemon said which mode holds")
  (let [markup (render-switch (assoc-in loaded [:penforge :connection :status] :connected))]
    (t/is (str/includes? markup "class=\"chat\""))
    (t/is (re-find #"checked=\"\"[^>]*value=\"manual\"|value=\"manual\"[^>]*checked=\"\"" markup))
    (t/is (not (str/includes? markup "disabled"))))
  (t/is (str/includes? (render-switch loaded) "disabled") "nothing to switch without the daemon"))

(t/deftest only-known-modes-are-sent
  (t/is (= :auto (mode/parse-mode "auto")))
  (t/is (= :manual (mode/parse-mode "manual")))
  (t/is (nil? (mode/parse-mode "bypass")))
  (let [sent (atom nil)]
    (with-redefs [client/send! (fn [message] (reset! sent message) true)]
      (ptk/effect (settings/set-permission-mode :auto) {} nil))
    (t/is (= "auto" (:permission-mode @sent)))))
