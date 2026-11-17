;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-chat-test
  (:require
   [app.main.data.ai.chat :as chat]
   [cljs.test :as t :include-macros true]))

(def ^:private base
  (assoc chat/empty-chat :conversation-id "c1"))

(defn- reduce-messages
  [chat messages]
  (reduce chat/apply-message chat messages))

(t/deftest deltas-build-one-streaming-assistant-entry
  (let [chat (reduce-messages base
                              [{:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hel"}
                               {:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "lo"}])]
    (t/is (= :streaming (:status chat)))
    (t/is (= 1 (count (:entries chat))))
    (t/is (= {:kind :assistant :id "m1" :text "Hello" :streaming true}
             (first (:entries chat))))))

(t/deftest done-ends-the-turn
  (let [chat (reduce-messages base
                              [{:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hi"}
                               {:type "chat.tool" :conversation-id "c1" :tool-name "t"
                                :summary "Reading" :status "running"}
                               {:type "chat.done" :conversation-id "c1" :message-id "m1"
                                :usage {:output-tokens 2}}])]
    (t/is (= :idle (:status chat)))
    (t/is (not (contains? (first (:entries chat)) :streaming)))
    (t/is (= {:output-tokens 2} (:usage (first (:entries chat)))))
    (t/is (= :done (:status (second (:entries chat)))) "running tools close with the turn")))

(t/deftest messages-of-other-conversations-are-ignored
  (let [chat (reduce-messages base
                              [{:type "chat.delta" :conversation-id "other" :message-id "m1" :text "x"}
                               {:type "chat.done" :conversation-id "other" :message-id "m1"}])]
    (t/is (= base chat))))

(t/deftest tool-lines-update-in-place
  (let [chat  (reduce-messages base
                               [{:type "chat.tool" :conversation-id "c1" :tool-name "a"
                                 :summary "Reading the design" :status "running"}
                                {:type "chat.tool" :conversation-id "c1" :tool-name "b"
                                 :summary "Looking" :status "running"}
                                {:type "chat.tool" :conversation-id "c1" :tool-name "a"
                                 :summary "Read the design" :status "done" :detail "{}"}])
        [a b] (:entries chat)]
    (t/is (= 2 (count (:entries chat))))
    (t/is (= [:done "Read the design" "{}"] [(:status a) (:summary a) (:detail a)]))
    (t/is (= :running (:status b)))))

(t/deftest history-goes-before-live-entries
  (let [chat (-> base
                 (chat/add-user-message "u2" "live")
                 (chat/apply-message {:type "chat.history" :rid "r" :conversation-id "c1"
                                      :messages [{:role "user" :message-id "u1" :text "old" :ts "t"}
                                                 {:role "assistant" :message-id "a1" :text "answer" :ts "t"}]}))]
    (t/is (= ["u1" "a1" "u2"] (mapv :id (:entries chat))))
    (t/is (= [:user :assistant :user] (mapv :kind (:entries chat))))
    (t/is (= :loaded (:history-status chat)))))

(t/deftest failed-history-request-is-not-an-error-entry
  (let [chat (-> base
                 (assoc :history-rid "h1")
                 (chat/apply-message {:type "error" :rid "h1" :code "not-implemented" :message "x"}))]
    (t/is (empty? (:entries chat)))
    (t/is (= :error (:history-status chat)))))

(t/deftest errors-become-entries
  (let [chat (chat/apply-message base {:type "error" :code "busy" :message "Busy"})]
    (t/is (= [:error "busy"] ((juxt :kind :code) (first (:entries chat)))))))

(t/deftest permission-requests-wait-for-an-answer
  (let [chat  (-> base
                  (chat/apply-message {:type "permission.request" :request-id "p1" :title "Write files"
                                       :description "d" :risk "high"})
                  (chat/answer-entry "p1" :allowed))
        entry (first (:entries chat))]
    (t/is (= [:permission :high :allowed] ((juxt :kind :risk :answer) entry)))))

(t/deftest workflow-runs-follow-their-request
  (let [chat           (-> base
                           (assoc-in [:pending-runs "rid1"] {:name "auto-name" :silent false})
                           (reduce-messages
                            [{:type "workflow.started" :rid "rid1" :run-id "run1" :name "auto-name"}
                             {:type "workflow.event" :run-id "run1" :kind "progress" :payload "Naming layers"}
                             {:type "workflow.event" :run-id "run1" :kind "question"
                              :payload {:question-id "q1" :text "Rename?" :options [{:id "y" :label "Yes"}]}}
                             {:type "workflow.event" :run-id "run1" :kind "log" :payload "debug"}
                             {:type "workflow.event" :run-id "other" :kind "question" :payload {:question-id "q2"}}
                             {:type "workflow.done" :run-id "run1" :ok true :summary "Named 3 layers"}]))
        [run question] (:entries chat)]
    (t/is (empty? (:pending-runs chat)))
    (t/is (= [:workflow :done "Named 3 layers" "Naming layers"]
             ((juxt :kind :status :summary :progress) run)))
    (t/is (= [:question "q1" "run1"] ((juxt :kind :id :run-id) question)))
    (t/is (= 2 (count (:entries chat))) "events of unknown runs are ignored")
    (t/is (= [{:kind "log" :payload "debug"}] (get-in chat [:runs "run1" :events])))))

(t/deftest silent-runs-stay-out-of-the-timeline
  (let [chat (-> base
                 (assoc-in [:pending-runs "rid1"] {:name "x" :silent true})
                 (reduce-messages
                  [{:type "workflow.started" :rid "rid1" :run-id "run1" :name "x"}
                   {:type "workflow.done" :run-id "run1" :ok false :summary "" :error "boom"}]))]
    (t/is (empty? (:entries chat)))
    (t/is (= :error (get-in chat [:runs "run1" :status])))))

(t/deftest failed-run-requests-report-once
  (let [chat (-> base
                 (assoc-in [:pending-runs "rid1"] {:name "x" :silent false})
                 (chat/apply-message {:type "error" :rid "rid1" :code "unknown-workflow" :message "no"}))]
    (t/is (empty? (:pending-runs chat)))
    (t/is (= "unknown-workflow" (:code (first (:entries chat)))))))

(t/deftest end-turn-closes-streaming-entries
  (let [chat (-> base
                 (reduce-messages
                  [{:type "chat.delta" :conversation-id "c1" :message-id "m1" :text "Hi"}
                   {:type "chat.tool" :conversation-id "c1" :tool-name "t" :summary "s" :status "running"}])
                 (chat/end-turn))]
    (t/is (= :idle (:status chat)))
    (t/is (not (contains? (first (:entries chat)) :streaming)))
    (t/is (= :error (:status (second (:entries chat)))))))

(t/deftest user-messages-take-the-pending-attachments
  (let [node {:kind "node" :file-id "f" :page-id "p" :node-id "n1" :name "Card" :type "frame"}
        chat (-> base
                 (chat/add-attachments [node node])
                 (chat/add-attachments [node (assoc node :node-id "n2")]))
        sent (chat/add-user-message chat "u1" "Fix this")]
    (t/is (= ["n1" "n2"] (mapv :node-id (:attachments chat))) "duplicates are skipped")
    (t/is (empty? (:attachments sent)))
    (t/is (= :streaming (:status sent)))
    (t/is (= ["n1" "n2"] (mapv :node-id (:attachments (peek (:entries sent))))))))
