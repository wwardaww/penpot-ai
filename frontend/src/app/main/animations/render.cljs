;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.render
  "Pushes animation values into render-wasm as temporary overrides and
  puts the real values back. Nothing here touches the store or the file:
  render-wasm keeps its own copy of the shapes, these calls only change
  that copy (see `wiki/research/animation-playback.md`)."
  (:require
   [app.common.files.helpers :as cfh]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]
   [app.common.math :as mth]
   [app.common.render-wasm.api.select :as wselect]
   [app.common.render-wasm.helpers :as h]
   [app.common.render-wasm.wasm :as wasm]
   [app.render-wasm.api :as api]))

;; --- Geometry

(def ^:private transform-props
  [:translateX :translateY :scale :scaleX :scaleY :rotate])

(defn- transform-identity?
  [{:keys [translateX translateY scale scaleX scaleY rotate]}]
  (and (mth/almost-zero? (or translateX 0))
       (mth/almost-zero? (or translateY 0))
       (mth/almost-zero? (- (or scale 1) 1))
       (mth/almost-zero? (- (or scaleX 1) 1))
       (mth/almost-zero? (- (or scaleY 1) 1))
       (mth/almost-zero? (mod (or rotate 0) 360))))

(defn has-transform?
  [values]
  (and (some #(contains? values %) transform-props)
       (not (transform-identity? values))))

(defn own-matrix
  "Matrix of a layer's own animation values, around the layer center, in
  page coordinates."
  [shape {:keys [translateX translateY scale scaleX scaleY rotate]}]
  (let [center (grc/rect->center (:selrect shape))
        cx     (:x center)
        cy     (:y center)
        s      (or scale 1)
        sx     (* s (or scaleX 1))
        sy     (* s (or scaleY 1))]
    (gmt/multiply (gmt/translate-matrix (+ cx (or translateX 0)) (+ cy (or translateY 0)))
                  (gmt/rotate-matrix (or rotate 0))
                  (gmt/scale-matrix (gpt/point sx sy))
                  (gmt/translate-matrix (- cx) (- cy)))))

(defn- depth
  [objects id]
  (count (cfh/get-parent-ids objects id)))

(defn world-matrices
  "Map id → matrix for every animated layer and all its descendants.
  A layer inherits the matrix of its animated ancestors (composed with its
  own), except ids in `absolute`, whose own matrix already maps them to
  their place (smart animate)."
  [objects values absolute]
  (let [animated (->> values
                      (filter (fn [[id v]] (and (contains? objects id) (has-transform? v))))
                      (map key)
                      (sort-by #(depth objects %)))]
    (reduce (fn [acc id]
              (let [shape    (get objects id)
                    own      (own-matrix shape (get values id))
                    parent-w (get acc (:parent-id shape))
                    world    (if (or (contains? absolute id) (nil? parent-w))
                               own
                               (gmt/multiply parent-w own))]
                (reduce #(assoc %1 %2 world)
                        (assoc acc id world)
                        (cfh/get-children-ids objects id))))
            {}
            animated)))

;; --- Paint overrides

(defn- shimmer-fill
  [p]
  (let [pos (+ -0.25 (* 1.5 p))
        a   (mth/clamp (- pos 0.25) 0 1)
        b   (mth/clamp pos 0 1)
        c   (mth/clamp (+ pos 0.25) 0 1)]
    (when (< a c)
      {:fill-opacity 1
       :fill-color-gradient
       {:type :linear :start-x 0 :start-y 0.5 :end-x 1 :end-y 0.5 :width 1
        :stops [{:color "#ffffff" :opacity 0 :offset a}
                {:color "#ffffff" :opacity 0.6 :offset b}
                {:color "#ffffff" :opacity 0 :offset c}]}})))

(defn- recolor-fills
  [fills color]
  (if (and (seq fills) (some? (:fill-color (first fills))))
    (assoc-in (vec fills) [0 :fill-color] color)
    (into [{:fill-color color :fill-opacity 1}] fills)))

(defn- state-shadow
  [{:keys [offsetX offsetY blur spread color opacity]}]
  {:id nil
   :style :drop-shadow
   :offset-x (or offsetX 0)
   :offset-y (or offsetY 0)
   :blur (max 0 (or blur 0))
   :spread (or spread 0)
   :hidden false
   :color {:color (or color "#000000") :opacity (mth/clamp (or opacity 0.2) 0 1)}})

(defn- paint-props
  "Overridden paint props of one layer: map of wasm prop → value."
  [shape {:keys [opacity blur fill shimmer shadow radius]}]
  (let [text?   (cfh/text-shape? shape)
        fills   (:fills shape)
        fills   (cond-> fills
                  (and (some? fill) (not text?)) (recolor-fills fill))
        shimmer (when (and (some? shimmer) (not text?)) (shimmer-fill shimmer))]
    (cond-> {}
      (and (some? opacity) (not (mth/almost-zero? (- opacity 1))))
      (assoc :opacity (mth/clamp (* (or (:opacity shape) 1) opacity) 0 1))

      (and (some? blur) (> blur 0.05))
      (assoc :blur (max blur (or (some-> (:blur shape) :value) 0)))

      (or (and (some? fill) (not text?)) (some? shimmer))
      (assoc :fills (cond-> (vec fills) (some? shimmer) (conj shimmer)))

      (some? shadow)
      (assoc :shadow [(state-shadow shadow)])

      (some? radius)
      (assoc :radius (max 0 radius)))))

(defn- write-prop
  [shape prop value]
  (case prop
    :opacity (api/set-shape-opacity value)
    :blur    (api/set-shape-blur {:type :layer-blur :value value :hidden false})
    :fills   (api/set-shape-fills (:id shape) value false)
    :shadow  (api/set-shape-shadows value)
    :radius  (api/set-shape-corners [value value value value])))

(defn- restore-prop
  [shape prop]
  (case prop
    :opacity (api/set-shape-opacity (:opacity shape))
    :blur    (api/set-shape-blur (:blur shape))
    :fills   (api/set-shape-fills (:id shape) (:fills shape) false)
    :shadow  (api/set-shape-shadows (:shadow shape))
    :radius  (api/set-shape-corners [(:r1 shape) (:r2 shape) (:r3 shape) (:r4 shape)])))

;; --- Frames

(def empty-state
  {:modified #{} :painted {}})

(defn apply-frame
  "Writes one frame. `values` maps layer id → animation values, `absolute`
  is the set of ids whose matrix is absolute. `state` is what the previous
  frame left (see `empty-state`); returns the new state. Layers no longer
  animated get their real values back."
  [objects values absolute state]
  (let [worlds    (world-matrices objects values absolute)
        modified  (set (keys worlds))
        prev-mod  (:modified state)]
    ;; A shape that leaves the modifier set must have its old area
    ;; repainted: render-wasm only does that through clean-modifiers.
    (when (some #(not (contains? modified %)) prev-mod)
      (api/clean-modifiers))
    (if (seq worlds)
      (api/set-modifiers (into [] (map (fn [[id m]] [id m])) worlds))
      (when (seq prev-mod) (api/clean-modifiers)))

    (let [painted
          (reduce-kv
           (fn [acc id v]
             (let [shape (get objects id)]
               (if (or (nil? shape) (:hidden shape))
                 acc
                 (let [props (paint-props shape v)
                       prev  (get-in state [:painted id] #{})]
                   (when (or (seq props) (seq prev))
                     (wselect/use-shape id)
                     (doseq [prop prev :when (not (contains? props prop))]
                       (restore-prop shape prop))
                     (doseq [[prop value] props]
                       (write-prop shape prop value)))
                   (cond-> acc (seq props) (assoc id (set (keys props))))))))
           {}
           values)]
      ;; Layers that had paint overrides and have no values this frame.
      (doseq [[id props] (:painted state)
              :when (not (contains? values id))
              :let [shape (get objects id)]
              :when (some? shape)]
        (wselect/use-shape id)
        (doseq [prop props] (restore-prop shape prop)))
      {:modified modified :painted painted})))

(defn restore
  "Puts back the real values of everything `state` overrode."
  [objects state]
  (when (seq (:modified state))
    (api/clean-modifiers))
  (doseq [[id props] (:painted state)
          :let [shape (get objects id)]
          :when (some? shape)]
    (wselect/use-shape id)
    (doseq [prop props] (restore-prop shape prop)))
  empty-state)

(defn renderer-ready?
  []
  (api/initialized?))

(defn set-animation-mode
  "Interactive-transform rendering without fast mode while playing in the
  workspace (render-wasm `_set_animation_mode`, W31). Older wasm builds
  lack it: fall back to the drag mode (correct, without shadows)."
  [enabled]
  (when (api/initialized?)
    (if (some? (unchecked-get wasm/internal-module "_set_animation_mode"))
      (h/call wasm/internal-module "_set_animation_mode" enabled)
      (if enabled (api/set-modifiers-start) (api/set-modifiers-end)))))
