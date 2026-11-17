;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-ask-test
  (:require
   ["jsdom" :refer [JSDOM]]
   [app.common.data :as d]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.ask :as ask]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.detached :as detached]
   [app.main.data.workspace.shortcuts :as wsc]
   [app.util.globals :as globals]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.mock :as mock]
   [potok.v2.core :as ptk]))

(def ^:private file-id (uuid/next))
(def ^:private page-id (uuid/next))
(def ^:private board-id (uuid/next))
(def ^:private rect-id (uuid/next))
(def ^:private group-id (uuid/next))

(def ^:private objects
  {board-id {:id board-id :name "Login" :type :frame :frame-id uuid/zero :parent-id uuid/zero}
   rect-id  {:id rect-id :name "Button" :type :rect :frame-id board-id :parent-id board-id}
   group-id {:id group-id :name "Logo" :type :group :frame-id uuid/zero :parent-id uuid/zero}})

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
  (t/is (= 1 (ask/snapshot-scale 512 512)))
  (t/is (= 0.5 (ask/snapshot-scale 1024 300)))
  (t/is (= 0.125 (ask/snapshot-scale 300 4096)))
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
  (let [attachments (ask/build-attachments (state) [rect-id (uuid/next) board-id rect-id])]
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
               :type "frame"}]
             attachments)
          "attachments go without snapshot; it is rendered afterwards")))

(defn- shape
  [type frame-id]
  (let [id (uuid/next)]
    {:id id :name (str id) :type type :frame-id frame-id :parent-id frame-id}))

(t/deftest snapshot-candidates-prefer-top-level-boards-and-are-capped
  (let [nested  (shape :rect board-id)
        child   (shape :group uuid/zero)
        boards  (vec (repeatedly 4 #(shape :frame uuid/zero)))
        shapes  (into [nested child] boards)]
    (t/is (= boards (ask/snapshot-candidates shapes []))
          "at most max-snapshots, root boards first")
    (t/is (= [(first boards) child nested]
             (ask/snapshot-candidates [nested child (first boards)] []))
          "then direct children of the root, then the rest")
    (t/testing "pending snapshots use up the room and are not rendered again"
      (let [pending [{:node-id (str (:id (first boards))) :snapshot-png "PNG"}
                     {:node-id (str (:id (second boards))) :snapshot-png "PNG"}
                     {:node-id (str (:id nested))}]]
        (t/is (= [(nth boards 2) (nth boards 3)]
                 (ask/snapshot-candidates shapes pending)))))
    (t/is (= [] (ask/snapshot-candidates shapes (mapv (fn [b] {:node-id (str (:id b)) :snapshot-png "P"})
                                                      boards))))))

(t/deftest ^:async render-snapshots-stores-pngs-in-pending-attachments
  (let [board    (get objects board-id)
        rect     (get objects rect-id)
        group    (get objects group-id)
        render   (fn [shape] (when-not (= :group (:type shape)) (str "PNG-" (:name shape))))
        pending  [{:kind "node" :node-id (str board-id)}
                  {:kind "node" :node-id (str group-id)}]
        state0   (state :chat (assoc chat/empty-chat :attachments pending))
        events   (atom [])]
    (await (async/observe (ask/render-snapshots [board rect group] render :async)
                          :on-next #(swap! events conj %)))
    (t/is (= 2 (count @events)) "a shape whose render fails sends no event")
    (let [chat (:penforge (reduce #(ptk/update %2 %1) state0 @events))]
      (t/is (= [{:kind "node" :node-id (str board-id) :snapshot-png "PNG-Login"}
                {:kind "node" :node-id (str group-id)}]
               (get-in chat [:chat :attachments]))
            "only pending attachments get a snapshot"))))

(t/deftest ^:async render-snapshots-without-renderer-or-shapes-is-empty
  (let [events (atom [])]
    (await (async/observe (ask/render-snapshots [(get objects board-id)] nil :async)
                          :on-next #(swap! events conj %)))
    (await (async/observe (ask/render-snapshots [] (constantly "PNG") :async)
                          :on-next #(swap! events conj %)))
    (t/is (empty? @events))))

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

(t/deftest ^:async ask-selection-while-detached-keeps-the-sidebar
  (let [state  (assoc-in (state :selected [board-id]
                                :chat (assoc chat/empty-chat :conversation-id "c1"))
                         [:penforge :detached] {:status :open :window-name "w"})
        events (atom [])]
    (await (async/observe (ptk/watch (ask/ask-selection) state (rx/subject))
                          :on-next #(swap! events conj %)))
    (t/is (= [::ask/add-attachments ::ask/focus-chat-input] (mapv ptk/type @events))
          "no open-chat: the sidebar would only show the detached notice")))

(defn- chat-dom
  "A jsdom window holding a chat panel input."
  []
  (.-window (JSDOM. (str "<!doctype html><html><body>"
                         "<article data-testid='ai-chat-panel'><textarea></textarea></article>"
                         "</body></html>"))))

(t/deftest ^:async chat-input-is-found-where-the-chat-lives
  (let [sidebar (chat-dom)
        popup   (chat-dom)
        input   #(.querySelector (.-document ^js %) "textarea")]
    (try
      (await
       (mock/with-mocks* {globals/document (.-document sidebar)
                          detached/chat-document (constantly nil)}
         (t/is (identical? (input sidebar) (ask/find-chat-input)) "docked: the sidebar")))
      (await
       (mock/with-mocks* {globals/document (.-document sidebar)
                          detached/chat-document (constantly (.-document popup))}
         (t/is (identical? (input popup) (ask/find-chat-input)) "detached: the window")))
      (finally
        (.close sidebar)
        (.close popup)))))
