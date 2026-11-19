;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-chat-actions-test
  "W37: edit, delete and revert of the user's chat messages: the
  protocol messages, the timeline changes and the hover actions."
  (:require
   ["react-dom/server" :as rds]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions.checkpoints :as dac]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.store :as st]
   [app.main.ui.ds.tooltip :as tooltip]
   [app.main.ui.workspace.ai.chat.panel :as panel]
   [app.util.i18n :as i18n]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private three-turns
  "A 3-turn conversation: user, steps and answers."
  [{:kind :user :id "u1" :text "hello"}
   {:kind :assistant :id "a1" :text "hi"}
   {:kind :user :id "u2" :text "make it teal"}
   {:kind :tool :id "t2" :tool-name "execute_code" :status :done}
   {:kind :assistant :id "a2" :text "done"}
   {:kind :user :id "u3" :text "add a zebra"}
   {:kind :tool :id "t3" :tool-name "execute_code" :status :done}
   {:kind :assistant :id "a3" :text "added"}])

(def ^:private base
  (assoc chat/empty-chat :conversation-id "c1" :entries three-turns))

(defn- ids
  [chat]
  (mapv :id (:entries chat)))

(defn- changed
  [action message-id & {:as extra}]
  (merge {:type "chat.changed" :rid "r1" :conversation-id "c1" :action action
          :message-id message-id :removed []}
         extra))

;; --- Protocol

(t/deftest action-messages-are-valid-client-messages
  (let [edit   (proto/chat-edit {:rid "r" :conversation-id "c1" :message-id "u2"
                                 :new-message-id "u2b" :text "teal, please"})
        delete (proto/chat-delete {:rid "r" :conversation-id "c1" :message-id "u2"})
        revert (proto/chat-revert {:rid "r" :conversation-id "c1" :message-id "u2"})
        send   (proto/chat-send {:rid "r" :conversation-id "c1" :text "hi" :message-id "u9"})]
    (t/is (proto/valid-client-message? edit))
    (t/is (proto/valid-client-message? delete))
    (t/is (proto/valid-client-message? revert))
    (t/is (true? (:confirmed revert)) "a revert is only sent after the user said yes")
    (t/is (= "u9" (:message-id send)))
    (t/is (proto/valid-client-message? send))))

(t/deftest chat-changed-decodes
  (let [msg (proto/decode (str "{\"type\":\"chat.changed\",\"rid\":\"r1\",\"conversationId\":\"c1\","
                               "\"action\":\"revert\",\"messageId\":\"u2\",\"removed\":[\"u2\",\"a2\"],"
                               "\"design\":\"restored\",\"checkpointId\":\"cp-4\"}"))]
    (t/is (= "chat.changed" (:type msg)))
    (t/is (= ["u2" "a2"] (:removed msg)))
    (t/is (= "cp-4" (:checkpoint-id msg))))
  (t/is (nil? (proto/decode "{\"type\":\"chat.changed\",\"rid\":\"r1\",\"conversationId\":\"c1\",\"action\":\"burn\",\"messageId\":\"u2\",\"removed\":[]}"))
        "unknown actions are dropped"))

;; --- Timeline

(t/deftest drop-turn-removes-a-message-and-its-turn
  (t/is (= ["u1" "a1" "u3" "t3" "a3"] (mapv :id (chat/drop-turn three-turns "u2"))))
  (t/is (= ["u1" "a1" "u2" "t2" "a2"] (mapv :id (chat/drop-turn three-turns "u3"))))
  (t/is (= three-turns (chat/drop-turn three-turns "a2")) "only user messages"))

(t/deftest drop-from-removes-everything-after
  (t/is (= ["u1" "a1"] (mapv :id (chat/drop-from three-turns "u2"))))
  (t/is (= three-turns (chat/drop-from three-turns "nope"))))

(t/deftest delete-reply-drops-the-turn
  (let [chat (-> base
                 (assoc :pending-action {:rid "r1" :action :delete :message-id "u2"})
                 (chat/apply-message (changed "delete" "u2")))]
    (t/is (= ["u1" "a1" "u3" "t3" "a3"] (ids chat)))
    (t/is (nil? (:pending-action chat)))))

(t/deftest revert-reply-drops-later-turns-and-says-so
  (let [chat (chat/apply-message base (changed "revert" "u2" :design "restored"))]
    (t/is (= ["u1" "a1"] (take 2 (ids chat))))
    (t/is (= {:kind :notice :code "reverted"} (select-keys (last (:entries chat)) [:kind :code]))))
  (let [chat (chat/apply-message base (changed "revert" "u3" :design "unchanged"))]
    (t/is (= "reverted-unchanged" (:code (last (:entries chat)))))))

(t/deftest replies-of-other-conversations-are-ignored
  (t/is (= base (chat/apply-message base (assoc (changed "delete" "u2") :conversation-id "c2")))))

(t/deftest edit-cuts-the-timeline-and-starts-a-turn
  (let [start (assoc-in base [:entries 2 :attachments] [{:kind "node" :node-id "n1"}])
        chat  (chat/edit-user-message start "u2" "u2b" "teal, please" "u2b")]
    (t/is (= ["u1" "a1" "u2b"] (ids chat)))
    (t/is (= {:kind :user :id "u2b" :text "teal, please" :attachments [{:kind "node" :node-id "n1"}]}
             (dissoc (last (:entries chat)) :ts))
          "the edited message keeps its attachments")
    (t/is (= :streaming (:status chat)))
    (t/is (= (:entries start) (get-in chat [:pending-action :entries]))
          "the timeline before the edit waits to be put back")
    (t/is (= base (chat/edit-user-message base "nope" "x" "t" "x")) "unknown ids change nothing")))

(t/deftest the-edit-answer-streams-in-after-the-reply
  (let [chat (-> (chat/edit-user-message base "u2" "u2b" "teal, please" "u2b")
                 (chat/apply-message (changed "edit" "u2" :rid "u2b"))
                 (chat/apply-message {:type "chat.delta" :conversation-id "c1" :message-id "a9" :text "ok"})
                 (chat/apply-message {:type "chat.done" :conversation-id "c1" :message-id "a9"}))]
    (t/is (= ["u1" "a1" "u2b" "a9"] (ids chat)))
    (t/is (nil? (:pending-action chat)))
    (t/is (= :idle (:status chat)))))

(t/deftest a-refused-edit-gives-the-timeline-back
  (let [chat (-> (chat/edit-user-message base "u2" "u2b" "teal, please" "u2b")
                 (chat/apply-message {:type "error" :rid "u2b" :code "busy" :message "busy"}))]
    (t/is (= (conj (mapv :id three-turns) (:id (last (:entries chat)))) (ids chat)))
    (t/is (= :error (:kind (last (:entries chat)))))
    (t/is (= :idle (:status chat)))
    (t/is (nil? (:pending-action chat)))))

(t/deftest a-refused-revert-keeps-the-messages
  (let [chat (-> base
                 (assoc :pending-action {:rid "r1" :action :revert :message-id "u2"})
                 (chat/apply-message {:type "error" :rid "r1" :code "internal"
                                      :message "The design could not be put back"}))]
    (t/is (= (mapv :id three-turns) (butlast (ids chat))))
    (t/is (= "internal" (:code (last (:entries chat)))))))

(t/deftest actions-wait-for-turns-and-other-actions
  (t/is (chat/can-act? base true))
  (t/is (not (chat/can-act? base false)) "not while disconnected")
  (t/is (not (chat/can-act? (assoc base :status :streaming) true)))
  (t/is (not (chat/can-act? (assoc base :pending-action {:rid "r"}) true))))

(t/deftest a-lost-connection-forgets-the-pending-action
  (t/is (nil? (:pending-action (chat/end-turn (assoc base :pending-action {:rid "r"}))))))

(t/deftest chat-checkpoints-have-a-name-in-the-ai-history
  (t/is (= "penforge.checkpoints.workflow.chat" (dac/workflow-label "chat"))))

;; --- Hover actions

(mf/defc tooltip-stub*
  [{:keys [children]}]
  children)

(def ^:private load-time-store
  {:state st/state :stream st/stream})

(defn- render-panel
  "Render the chat panel with `chat` merged into a connected chat state."
  [chat-state & {:keys [connected] :or {connected true}}]
  ;; the app's refs watch the load-time store; other namespaces `set!` new ones
  (let [previous {:state st/state :stream st/stream}]
    (set! st/state (:state load-time-store))
    (set! st/stream (:stream load-time-store))
    (let [old     @st/state
          file-id (uuid/next)
          page-id (uuid/next)]
      (reset! st/state {:current-file-id file-id
                        :current-page-id page-id
                        :files {file-id {:data {:pages-index {page-id {:objects {}}}}}}
                        :workspace-local {:selected #{}}
                        :workspace-layout #{:layers}
                        :penforge {:connection {:status (if connected :connected :disconnected)}
                                   :chat (merge base chat-state)}})
      (try
        (with-redefs [tooltip/tooltip* tooltip-stub*
                      i18n/tr (fn
                                ([key] key)
                                ([key & args] (str/join " " (cons key args))))]
          (rds/renderToStaticMarkup (mf/element panel/chat-panel* #js {})))
        (finally
          (reset! st/state old)
          (set! st/state (:state previous))
          (set! st/stream (:stream previous)))))))

(defn- count-of
  [markup part]
  (count (re-seq (re-pattern part) markup)))

(t/deftest user-messages-offer-edit-delete-and-revert
  (let [markup (render-panel {})]
    (t/is (= 3 (count-of markup "data-testid=\"ai-chat-message-actions\"")) "one toolbar per user message")
    ;; the buttons' labels live in tooltips, which static rendering leaves out
    (t/is (= 3 (count-of markup "#icon-pencil")) "edit")
    (t/is (= 3 (count-of markup "#icon-history")) "revert")
    (t/is (= 3 (count-of markup "#icon-delete")) "delete")))

(t/deftest no-actions-while-the-ai-answers-or-offline
  (t/is (zero? (count-of (render-panel {:status :streaming}) "ai-chat-message-actions")))
  (t/is (zero? (count-of (render-panel {} :connected false) "ai-chat-message-actions")))
  (t/is (zero? (count-of (render-panel {:pending-action {:rid "r"}}) "ai-chat-message-actions"))))

(t/deftest revert-notices-render
  (let [markup (render-panel {:entries [{:kind :user :id "u1" :text "hello"}
                                        {:kind :notice :id "n1" :code "reverted"}]})]
    (t/is (str/includes? markup "penforge.chat.message.reverted"))))
