;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.viewer.animations.player
  "Penforge (W31): layer animations in View mode. One persistent player
  per shown board (main screen or overlay): entrance and loops when the
  board appears, smart animate when it was reached through a smart
  navigation, hover/press states under the pointer, exit before leaving.

  Each frame re-renders the board into the viewer's offscreen canvas with
  `render-sync-shape` and copies it onto the visible canvas (see
  `wiki/research/animation-playback.md`)."
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.render-wasm.api.select :as wselect]
   [app.common.render-wasm.wasm :as wasm]
   [app.main.animations.driver :as driver]
   [app.main.animations.scene :as scene]
   [app.main.animations.spec :as spec]
   [app.main.animations.states :as states]
   [app.main.render-viewer-wasm :as rwv]
   [app.render-wasm.api :as wasm.api]
   [app.util.dom :as dom]
   [rumext.v2 :as mf]))

(def ^:private base-render-timeout
  "Ms to wait for the viewer's own first render of a board."
  5000)

(def ^:private smart-max-age
  "A smart navigation is played only if the board shows within this time."
  3000)

;; Boards shown now: frame-id → {:objects :backend}. Used to find the
;; board a navigation leaves.
(defonce ^:private screens (atom {}))

;; Smart navigation waiting for its destination board.
(defonce ^:private pending-smart (atom nil))

;; Board ids playing their exit before a navigation.
(defonce ^:private exiting (atom #{}))

(defn reduce-motion?
  []
  (and (exists? js/matchMedia)
       (.-matches (js/matchMedia "(prefers-reduced-motion: reduce)"))))

(defn- player-key
  [frame-id]
  [:viewer frame-id])

;; --- Drawing

(defn- blit
  [canvas os-canvas]
  (let [width  (.-width canvas)
        height (.-height canvas)
        bitmap (.transferToImageBitmap ^js os-canvas)
        ctx    (.getContext canvas "2d")]
    (.clearRect ctx 0 0 width height)
    (.drawImage ctx bitmap 0 0 width height)
    (.close bitmap)))

(defn- draw-passes
  "Renders the board through each pass (main layer, fixed-scroll layer) and
  copies it to the pass canvas, like `app.main.render-viewer-wasm` does
  for a still frame."
  [{:keys [objects frame-id scale render-size passes]}]
  (when-let [os-canvas (rwv/get-snapshot-canvas)]
    (let [prev @wasm/disable-request-render?]
      (reset! wasm/disable-request-render? true)
      (try
        (wasm.api/set-rulers-frame-visible! false)
        (wasm.api/set-rulers-visible! false)
        (doseq [{:keys [canvas include-ids clear-fills-ids]} passes
                :when (and (some? canvas) (.-isConnected canvas))]
          (wasm.api/clear-render-include-filter!)
          (when (seq include-ids)
            (wasm.api/set-render-include-filter! include-ids))
          (doseq [id clear-fills-ids]
            (wselect/use-shape id)
            (wasm.api/clear-shape-fills!))
          (wasm.api/set-viewer-viewport! scale render-size)
          (wasm.api/render-sync-shape frame-id)
          (wasm.api/clear-render-include-filter!)
          (doseq [id clear-fills-ids]
            (wselect/use-shape id)
            (wasm.api/set-shape-fills id (get-in objects [id :fills] []) false))
          (blit canvas os-canvas))
        (finally
          (reset! wasm/disable-request-render? prev))))))

;; --- Pointer → layer

(defn- page-point
  [event container {:keys [scale render-size]}]
  (let [{:keys [left top]} (dom/get-bounding-rect container)]
    (gpt/point (+ (/ (- (.-clientX event) left) scale) (:x render-size))
               (+ (/ (- (.-clientY event) top) scale) (:y render-size)))))

(defn- state-layers
  "Layers of the board with hover/press states, in paint order."
  [objects frame-id]
  (into []
        (keep (fn [id]
                (let [shape (get objects id)]
                  (when (and (some? shape) (not (:hidden shape)))
                    (when-let [st (:states (spec/get-shape-animations shape))]
                      {:id id :shape shape :states st})))))
        (cfh/get-children-ids-with-self objects frame-id)))

(defn- layer-at
  "Top-most layer with states under `point`, or nil."
  [layers point]
  (d/seek #(grc/contains-point? (:selrect (:shape %)) point) (rseq layers)))

;; --- Hook

(defn- states-source
  "Driver source for the hover/press weights in `weights*`."
  [layers weights*]
  (let [by-id (into {} (map (juxt :id identity)) layers)]
    {:values (fn [now]
               (reduce-kv (fn [acc id w]
                            (if-let [{:keys [shape states]} (get by-id id)]
                              (if-let [v (states/layer-values shape states w now)]
                                (assoc acc id v)
                                acc)
                              acc))
                          {}
                          @weights*))
     :done? (fn [now]
              (let [weights @weights*]
                (and (states/settled? weights now)
                     (every? (fn [[_ w]] (every? (fn [[_ {:keys [to]}]] (zero? to)) w))
                             weights))))
     :on-done (fn [] (reset! weights* {}))}))

(defn- start-plan
  "Entrance (or the pending smart animate) and loops of the board."
  [key backend objects frame-id]
  (let [smart   (let [p @pending-smart]
                  (when (and (some? p)
                             (= (:to p) frame-id)
                             (< (- (js/Date.now) (:at p)) smart-max-age))
                    p))
        _       (when smart (reset! pending-smart nil))
        motion? (not (reduce-motion?))
        loops   (when motion? (scene/loop-entries objects [frame-id] 0 nil))
        plan    (cond
                  (not motion?) nil
                  (some? smart)
                  (scene/smart-plan objects (:from smart) frame-id (:options smart))
                  :else
                  {:entries (scene/motion-entries objects [frame-id] :entrance 0)
                   :absolute #{}})]
    (when (seq (:entries plan))
      (driver/play key backend :enter
                   (driver/plan-source (:entries plan) {:absolute (:absolute plan)})
                   true))
    (when (seq loops)
      (driver/play key backend :loops (driver/plan-source loops) true))))

(defn- has-enter-animation?
  [objects frame-id]
  (and (not (reduce-motion?))
       (or (some? (when-let [p @pending-smart] (when (= (:to p) frame-id) p)))
           (seq (scene/motion-entries objects [frame-id] :entrance 0)))))

(defn- start-board
  "Sets the board up (enter animations, pointer states); returns the
  cleanup fn."
  [ctx-ref passes objects frame-id]
  (let [key       (player-key frame-id)
        alive*    (atom true)
        canvas    (some-> passes first :canvas-ref mf/ref-val)
        container (some-> canvas dom/get-parent)
        hidden?   (and (some? canvas) (has-enter-animation? objects frame-id))
        show      (fn [] (when (some? canvas) (dom/set-style! canvas "opacity" "1")))
        backend   {:get-objects (fn [] (:objects (mf/ref-val ctx-ref)))
                   :draw (fn []
                           (when @alive*
                             (some-> (mf/ref-val ctx-ref) (draw-passes))
                             (show)))}
        layers    (state-layers objects frame-id)
        weights*  (atom {})
        hovered*  (atom nil)
        pressed*  (atom nil)
        set-weight
        (fn [id state target]
          (when-let [layer (d/seek #(= id (:id %)) layers)]
            (let [st-spec (get-in layer [:states state])]
              (when (some? st-spec)
                (swap! weights* states/set-target id state target st-spec
                       (js/performance.now) (reduce-motion?))
                (when-not (driver/has-source? key :states)
                  (driver/play key backend :states (states-source layers weights*) true))))))
        on-move
        (fn [event]
          (let [layer (layer-at layers (page-point event container (mf/ref-val ctx-ref)))
                id    (:id layer)
                prev  @hovered*]
            (when (not= id prev)
              (reset! hovered* id)
              (when prev (set-weight prev :hover 0))
              (when id (set-weight id :hover 1)))))
        on-leave
        (fn [_]
          (when-let [prev @hovered*]
            (reset! hovered* nil)
            (set-weight prev :hover 0))
          (when-let [prev @pressed*]
            (reset! pressed* nil)
            (set-weight prev :press 0)))
        on-down
        (fn [event]
          (when-let [id (:id (layer-at layers (page-point event container (mf/ref-val ctx-ref))))]
            (reset! pressed* id)
            (set-weight id :press 1)))
        on-up
        (fn [_]
          (when-let [prev @pressed*]
            (reset! pressed* nil)
            (set-weight prev :press 0)))
        timer     (atom nil)]

    (swap! screens assoc frame-id {:objects objects :backend backend})
    (when hidden? (dom/set-style! canvas "opacity" "0"))

    ;; Wait for the viewer's own render of this board, then play.
    (let [started (js/performance.now)
          marker  (str "screenshot-" frame-id)
          wait    (fn wait []
                    (when @alive*
                      (cond
                        (and (some? canvas) (= marker (.-id canvas)))
                        (start-plan key backend objects frame-id)

                        (> (- (js/performance.now) started) base-render-timeout)
                        (show)

                        :else
                        (reset! timer (js/requestAnimationFrame wait)))))]
      (reset! timer (js/requestAnimationFrame wait)))

    (when (and (some? container) (seq layers))
      (.addEventListener container "pointermove" on-move)
      (.addEventListener container "pointerleave" on-leave)
      (.addEventListener container "pointerdown" on-down)
      (.addEventListener container "pointerup" on-up))

    (fn []
      (reset! alive* false)
      (some-> @timer js/cancelAnimationFrame)
      (when (some? container)
        (.removeEventListener container "pointermove" on-move)
        (.removeEventListener container "pointerleave" on-leave)
        (.removeEventListener container "pointerdown" on-down)
        (.removeEventListener container "pointerup" on-up))
      (show)
      (swap! screens dissoc frame-id)
      (swap! exiting disj frame-id)
      (driver/stop key))))

(defn use-viewer-animations
  "Plays the board's animations in View mode. `passes` are the canvases
  the viewer draws the board into: [{:canvas-ref :include-ids
  :clear-fills-ids}]."
  [{:keys [enabled objects frame-id scale render-size passes]}]
  (let [ctx-ref (mf/use-ref nil)]
    ;; Latest render context for the frame loop.
    (mf/with-effect [objects frame-id scale render-size passes]
      (mf/set-ref-val! ctx-ref {:objects objects
                                :frame-id frame-id
                                :scale scale
                                :render-size render-size
                                :passes (mapv (fn [{:keys [canvas-ref] :as pass}]
                                                (assoc pass :canvas (mf/ref-val canvas-ref)))
                                              passes)}))

    (mf/with-layout-effect [enabled frame-id objects]
      (when enabled
        (start-board ctx-ref passes objects frame-id)))))

;; --- Navigation

(defn- screen-of
  "Shown board that contains the layer `shape-id`:
  [frame-id {:objects :backend}] or nil."
  [shape-id]
  (some (fn [[frame-id {:keys [objects] :as screen}]]
          (when (or (= frame-id shape-id)
                    (some #(= % frame-id) (cfh/get-parent-ids objects shape-id)))
            [frame-id screen]))
        @screens))

(defn navigate
  "Runs a navigate interaction of `shape`: plays the exit animations of the
  board being left, then calls `go` with the Penpot transition to use
  (nil for smart animate, which this namespace plays on arrival)."
  [shape interaction destination go]
  (let [index         (d/index-of (:interactions shape) interaction)
        smart         (scene/get-smart-options shape index destination)
        [from-id screen] (screen-of (:id shape))
        objects       (:objects screen)
        motion?       (not (reduce-motion?))
        proceed       (fn []
                        (when (some? from-id) (swap! exiting disj from-id))
                        (if (and motion? (some? smart) (some? from-id))
                          (do
                            (reset! pending-smart {:from from-id :to destination
                                                   :options smart :at (js/Date.now)})
                            (go nil))
                          (go (:animation interaction))))
        exits         (when (and motion? (some? from-id))
                        (scene/exit-plan objects from-id))]
    (cond
      (and (some? from-id) (contains? @exiting from-id))
      nil

      (seq exits)
      (do
        (swap! exiting conj from-id)
        (driver/stop-source (player-key from-id) :enter)
        (driver/play (player-key from-id) (:backend screen) :exit
                     (driver/plan-source exits {:hold true :on-done proceed})
                     true))

      :else
      (proceed))))
