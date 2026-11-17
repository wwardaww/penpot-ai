;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-ask-test
  (:require
   [app.common.data :as d]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.ask :as ask]
   [app.main.data.ai.chat :as chat]
   [app.main.data.workspace.shortcuts :as wsc]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.async :as async]
   [potok.v2.core :as ptk]))

(def ^:private file-id (uuid/next))
(def ^:private page-id (uuid/next))
(def ^:private board-id (uuid/next))
(def ^:private rect-id (uuid/next))

(def ^:private objects
  {board-id {:id board-id :name "Login" :type :frame}
   rect-id  {:id rect-id :name "Button" :type :rect}})

(defn- state
  [& {:keys [selected chat]}]
  (cond-> {:current-file-id file-id
           :current-page-id page-id
           :files {file-id {:data {:pages-index {page-id {:objects objects}}}}}
           :workspace-local {:selected (d/ordered-set)}}
    (some? selected) (assoc-in [:workspace-local :selected] (into (d/ordered-set) selected))
    (some? chat)     (assoc-in [:penforge :chat] chat)))

(t/deftest snapshot-scale-fits-the-longest-side
  (t/is (= 1 (ask/snapshot-scale 200 100)) "small shapes keep scale 1")
  (t/is (= 1 (ask/snapshot-scale 1024 1024)))
  (t/is (= 0.5 (ask/snapshot-scale 2048 300)))
  (t/is (= 0.25 (ask/snapshot-scale 300 4096)))
  (t/is (<= (* 3000 (ask/snapshot-scale 3000 10)) ask/max-snapshot-size)))

(t/deftest bytes->base64-matches-btoa
  (let [small (js/Uint8Array. #js [104 105 0 255])]
    (t/is (= (js/btoa (str "hi" (js/String.fromCharCode 0) (js/String.fromCharCode 255)))
             (ask/bytes->base64 small))))
  (t/testing "inputs larger than one chunk"
    (let [size  70000
          bytes (js/Uint8Array. size)
          _     (dotimes [i size] (aset bytes i (mod i 256)))
          text  (apply str (map #(js/String.fromCharCode (mod % 256)) (range size)))]
      (t/is (= (js/btoa text) (ask/bytes->base64 bytes))))))

(t/deftest build-attachments-keeps-order-skips-missing-and-duplicates
  (let [snapshot    (fn [shape] (when (= :frame (:type shape)) "PNG"))
        attachments (ask/build-attachments (state) [rect-id (uuid/next) board-id rect-id] snapshot)]
    (t/is (= [{:kind "node"
               :file-id (str file-id)
               :page-id (str page-id)
               :node-id (str rect-id)
               :name "Button"
               :type "rect"}
              {:kind "node"
               :file-id (str file-id)
               :page-id (str page-id)
               :node-id (str board-id)
               :name "Login"
               :type "frame"
               :snapshot-png "PNG"}]
             attachments))))

(t/deftest merge-attachments-does-not-duplicate-nodes
  (let [plain    {:kind "node" :node-id "a" :name "A"}
        with-png (assoc plain :snapshot-png "PNG")
        other    {:kind "node" :node-id "b" :name "B" :snapshot-png "PNG-B"}
        chat     (-> chat/empty-chat
                     (ask/merge-attachments [plain])
                     (ask/merge-attachments [with-png other])
                     (ask/merge-attachments [other]))]
    (t/is (= [with-png other] (:attachments chat))
          "the node attached without snapshot gains it, nothing is repeated")))

(t/deftest ask-action-is-registered
  (let [registry @actions/registry
        action   (get registry :ai/ask)]
    (t/is (some? action))
    (t/is (= #{:context-menu :command-palette} (:scopes action)))
    (t/is (fn? (:label action)))
    (t/is (false? (actions/enabled? action (state))) "disabled without selection")
    (t/is (true? (actions/enabled? action (state :selected [board-id]))))))

(t/deftest ai-ask-shortcut-uses-a-free-combo
  (let [entry    (get wsc/ai-shortcuts :ai-ask)
        commands (fn [shortcuts]
                   (into #{}
                         (mapcat (fn [{:keys [command]}]
                                   (if (vector? command) command [command])))
                         (vals shortcuts)))]
    (t/is (fn? (:label entry)))
    (t/is (= [:workspace] (:section entry)))
    (t/is (not (contains? (commands (apply dissoc wsc/shortcuts (keys wsc/ai-shortcuts)))
                          (:command entry)))
          "no other workspace shortcut uses the same keys")))

(t/deftest ^:async ask-selection-attaches-opens-and-focuses
  (let [state   (state :selected [board-id rect-id]
                       :chat (assoc chat/empty-chat :conversation-id "c1"))
        events  (atom [])]
    (await (async/observe (ptk/watch (ask/ask-selection) state (rx/subject))
                          :on-next #(swap! events conj %)))
    (let [[attach & others] @events
          chat              (get-in (ptk/update attach state) [:penforge :chat])]
      (t/is (= [(str board-id) (str rect-id)] (mapv :node-id (:attachments chat))))
      (t/is (= [::chat/open-chat ::ask/focus-chat-input] (mapv ptk/type others))))))

(t/deftest ^:async ask-selection-without-shapes-only-opens-the-chat
  (let [events (atom [])]
    (await (async/observe (ptk/watch (ask/ask-selection) (state) (rx/subject))
                          :on-next #(swap! events conj %)))
    (t/is (= [::chat/open-chat ::ask/focus-chat-input] (mapv ptk/type @events)))))
