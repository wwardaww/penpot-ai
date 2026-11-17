;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.ask
  "Ask AI about the selection (W06).

  Attaches every selected shape to the next chat message as a node
  attachment, shows the AI chat and puts the cursor in its input. While
  the chat is detached (W10) it brings the detached window to the front
  and focuses the input there, leaving the sidebar alone. A few
  of the shapes (top-level boards first) also get a PNG snapshot,
  rendered afterwards, one per animation frame, so a large selection
  does not freeze the UI or flood the message; the agent can capture
  the others with its screenshot tool. Runs from the context menu and
  the command palette (registry action `:ai/ask`) and from the
  workspace shortcut `:ai-ask`."
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.logging :as log]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.detached :as detached]
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

(def max-snapshots
  "Most attachments of one message that carry a snapshot."
  4)

(def max-snapshot-size
  "Longest side of a snapshot, in pixels."
  512)

;; --- Snapshots

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
  "Snapshot function (shape -> base64 PNG or nil) for the given state, or
  nil when nothing can render one. Only render-wasm renders snapshots;
  without it the attachments go without them."
  [state]
  (when (features/active-feature? state "render-wasm/v1")
    wasm-snapshot))

(defn snapshot-candidates
  "Shapes to render a snapshot for: the ones not attached with a
  snapshot yet, top-level boards first, then direct children of the
  root, then the rest, each group in selection order; at most
  `max-snapshots` minus the snapshots already pending."
  [shapes pending]
  (let [with-png (into #{}
                       (comp (filter :snapshot-png) (map :node-id))
                       pending)
        room     (max 0 (- max-snapshots (count with-png)))]
    (->> shapes
         (remove #(contains? with-png (str (:id %))))
         ;; `sort-by` is stable: selection order holds inside each group
         (sort-by #(cond
                     (cfh/root-frame? %) 0
                     (cfh/is-direct-child-of-root? %) 1
                     :else 2))
         (take room)
         (vec))))

(defn- set-snapshot
  "Store a rendered snapshot in the pending attachment of its node, if it
  is still pending."
  [node-id png]
  (ptk/reify ::set-snapshot
    ptk/UpdateEvent
    (update [_ state]
      (if (some #(= node-id (:node-id %)) (get-in state [:penforge :chat :attachments]))
        (update-in state [:penforge :chat :attachments]
                   (fn [attachments]
                     (mapv #(cond-> % (= node-id (:node-id %)) (assoc :snapshot-png png))
                           attachments)))
        state))))

(defn render-snapshots
  "Stream of `set-snapshot` events for `shapes`, one render per
  animation frame (`scheduler`, `:af` by default). Completes at once
  when there is nothing to render."
  ([shapes render]
   (render-snapshots shapes render :af))
  ([shapes render scheduler]
   (if (or (empty? shapes) (nil? render))
     (rx/empty)
     (->> (rx/from shapes)
          (rx/mapcat (fn [shape]
                       (->> (rx/of shape)
                            (rx/observe-on scheduler)
                            (rx/map (fn [shape]
                                      (when-let [png (render shape)]
                                        (set-snapshot (str (:id shape)) png))))
                            (rx/filter some?))))))))

;; --- Attachments

(defn- lookup-shapes
  "Shapes of the current page with `shape-ids`, in the given order, no
  repeats; ids that no longer exist are skipped."
  [state shape-ids]
  (let [objects (dsh/lookup-page-objects state)]
    (into []
          (comp (keep #(get objects %))
                (d/distinct-xf :id))
          shape-ids)))

(defn build-attachments
  "Node attachments (without snapshot) of the shapes with `shape-ids` on
  the current page, in the given order; missing shapes are skipped."
  [state shape-ids]
  (let [file-id (:current-file-id state)
        page-id (:current-page-id state)]
    (mapv #(proto/node-attachment file-id page-id %)
          (lookup-shapes state shape-ids))))

(defn- add-attachments
  [attachments]
  (ptk/reify ::add-attachments
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat]
                 (fnil chat/add-attachments chat/empty-chat)
                 attachments))))

;; --- Chat input

(def ^:private input-selector
  "[data-testid='ai-chat-panel'] textarea")

(defn find-chat-input
  "The chat input element, or nil while it is not mounted. The only place
  that knows where the chat lives: while the chat is detached (W10) the
  input is in the detached window's document."
  []
  (if-let [document (detached/chat-document)]
    (.querySelector ^js document input-selector)
    (dom/query input-selector)))

(defn- focus-chat-input!
  "Focus the chat input. The panel mounts after the sidebar switches to
  the AI tab (or, detached, after the window page loads), so look for it
  a few times before giving up."
  ([] (focus-chat-input! 20))
  ([attempts]
   (if-let [input (find-chat-input)]
     (dom/focus! input)
     (when (pos? attempts)
       (js/setTimeout #(focus-chat-input! (dec attempts)) 50)))))

(defn- focus-chat-input
  []
  (ptk/reify ::focus-chat-input
    ptk/EffectEvent
    (effect [_ state _]
      ;; Focusing an element does not raise its window.
      (when (detached/detached? state)
        (detached/focus-window!))
      (focus-chat-input!))))

;; --- Event and action

(defn ask-selection
  "Attach the selected shapes to the next chat message, show the AI chat
  and focus its input, then render the snapshots of a few of them. With
  nothing selected it only shows the chat."
  ([]
   (ask-selection nil))
  ([shape-ids]
   (ptk/reify ::ask-selection
     ptk/WatchEvent
     (watch [_ state stream]
       (let [shape-ids   (or shape-ids (dsh/get-selected-ids state))
             shapes      (lookup-shapes state shape-ids)
             attachments (build-attachments state shape-ids)
             pending     (get-in state [:penforge :chat :attachments])
             candidates  (snapshot-candidates shapes pending)
             stopper-s   (rx/filter (ptk/type? ::chat/finalize) stream)]
         (rx/concat
          (if (seq attachments)
            (rx/of (add-attachments attachments))
            (rx/empty))
          ;; Detached, the sidebar only shows a notice: do not switch
          ;; the user away from the panel they are on.
          (if (detached/detached? state)
            (rx/empty)
            (rx/of (chat/open-chat)))
          (rx/of (focus-chat-input))
          (->> (render-snapshots candidates (snapshot-fn state))
               (rx/take-until stopper-s))))))))

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
