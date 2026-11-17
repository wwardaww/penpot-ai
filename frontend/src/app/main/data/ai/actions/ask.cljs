;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.ask
  "Ask AI about the selection (W06).

  Attaches every selected shape to the next chat message as a node
  attachment with a PNG snapshot, shows the AI chat and puts the
  cursor in its input. Runs from the context menu and the command
  palette (registry action `:ai/ask`) and from the workspace shortcut
  `:ai-ask`."
  (:require
   [app.common.data :as d]
   [app.common.logging :as log]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.exports.wasm :as wasm.exports]
   [app.main.data.helpers :as dsh]
   [app.main.features :as features]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.render-wasm.api :as wasm.api]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(log/set-level! :warn)

(def max-snapshot-size
  "Longest side of a snapshot, in pixels."
  1024)

(defn snapshot-scale
  "Scale, at most 1, that fits a `width` x `height` shape in
  `max-snapshot-size` pixels on its longest side."
  [width height]
  (let [longest (max width height)]
    (if (> longest max-snapshot-size)
      (/ max-snapshot-size longest)
      1)))

(defn bytes->base64
  "Base64 of a byte array. Works in chunks so large images do not
  overflow the argument list of `String.fromCharCode`."
  [^js bytes]
  (let [chunk-size 0x8000
        length     (.-length bytes)]
    (loop [offset 0
           parts  #js []]
      (if (< offset length)
        (let [chunk (.subarray bytes offset (min length (+ offset chunk-size)))]
          (.push parts (.apply (.-fromCharCode js/String) nil chunk))
          (recur (+ offset chunk-size) parts))
        (js/btoa (.join parts ""))))))

(defn- wasm-snapshot
  "PNG snapshot of a shape as base64, rendered by render-wasm. Nil when
  the renderer is not ready or the render fails."
  [shape]
  (when (wasm.api/initialized?)
    (try
      (let [shape-id (:id shape)
            {:keys [width height]} (or (wasm.api/get-shape-extrect shape-id)
                                       (:selrect shape))
            bytes    (wasm.exports/export-bytes {:type :png
                                                 :scale (snapshot-scale width height)
                                                 :object-id shape-id})]
        (when (and (some? bytes) (pos? (.-length ^js bytes)))
          (bytes->base64 bytes)))
      (catch :default cause
        (log/wrn :hint "unable to render the snapshot of a shape"
                 :shape-id (str (:id shape))
                 :cause cause)
        nil))))

(defn snapshot-fn
  "Snapshot function for the given state: renders with render-wasm when
  it is active. Without it the attachment goes without a snapshot; the
  agent can still capture the node with its screenshot tool."
  [state]
  (if (features/active-feature? state "render-wasm/v1")
    wasm-snapshot
    (constantly nil)))

(defn build-attachments
  "Node attachments of the shapes with `shape-ids` on the current page,
  in the given order. `snapshot` is a fn of the shape returning a base64
  PNG or nil; shapes that no longer exist are skipped."
  [state shape-ids snapshot]
  (let [file-id (:current-file-id state)
        page-id (:current-page-id state)
        objects (dsh/lookup-page-objects state)]
    (into []
          (comp (keep #(get objects %))
                (d/distinct-xf :id)
                (map (fn [shape]
                       (let [attachment (proto/node-attachment file-id page-id shape)
                             png        (snapshot shape)]
                         (cond-> attachment
                           (some? png) (assoc :snapshot-png png))))))
          shape-ids)))

(defn merge-attachments
  "Add `attachments` to the pending attachments of the chat. A node
  already attached is not added again; it only gains the snapshot when
  it had none."
  [chat attachments]
  (let [snapshots (into {}
                        (keep (fn [{:keys [node-id snapshot-png]}]
                                (when snapshot-png [node-id snapshot-png])))
                        attachments)]
    (-> (chat/add-attachments chat attachments)
        (update :attachments
                (fn [current]
                  (mapv (fn [{:keys [node-id] :as attachment}]
                          (if-let [png (and (nil? (:snapshot-png attachment))
                                            (get snapshots node-id))]
                            (assoc attachment :snapshot-png png)
                            attachment))
                        current))))))

(defn- add-attachments
  [attachments]
  (ptk/reify ::add-attachments
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat]
                 (fnil merge-attachments chat/empty-chat)
                 attachments))))

(def ^:private input-selector
  "[data-testid='ai-chat-panel'] textarea")

(defn- focus-input!
  "Focus the chat input. The panel mounts after the sidebar switches to
  the AI tab, so look for it a few times before giving up."
  ([] (focus-input! 20))
  ([attempts]
   (if-let [input (dom/query input-selector)]
     (dom/focus! input)
     (when (pos? attempts)
       (js/setTimeout #(focus-input! (dec attempts)) 50)))))

(defn- focus-chat-input
  []
  (ptk/reify ::focus-chat-input
    ptk/EffectEvent
    (effect [_ _ _]
      (focus-input!))))

(defn ask-selection
  "Attach the selected shapes (with snapshots) to the next chat message,
  show the AI chat and focus its input. With nothing selected it only
  shows the chat."
  ([]
   (ask-selection nil))
  ([shape-ids]
   (ptk/reify ::ask-selection
     ptk/WatchEvent
     (watch [_ state _]
       (let [shape-ids   (or shape-ids (dsh/get-selected-ids state))
             attachments (build-attachments state shape-ids (snapshot-fn state))]
         (rx/concat
          (if (seq attachments)
            (rx/of (add-attachments attachments))
            (rx/empty))
          (rx/of (chat/open-chat)
                 (focus-chat-input))))))))

(defn- has-selection?
  [state]
  (boolean (seq (dsh/get-selected-ids state))))

(actions/register-action!
 {:id :ai/ask
  :label #(tr "penforge.actions.ask")
  :icon i/feedback
  :order 1
  :scopes #{:context-menu :command-palette}
  :enabled? has-selection?
  :run (fn [{:keys [selected]}]
         (st/emit! (ask-selection selected)))})
