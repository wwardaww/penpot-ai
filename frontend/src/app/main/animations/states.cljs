;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.states
  "Hover and press states: per layer weights that move towards 0 or 1 with
  the state's duration/easing, and the layer values they produce. Pure:
  times are passed in."
  (:require
   [app.common.math :as mth]
   [app.main.animations.presets :as presets]
   [app.main.animations.timeline :as tl]))

(defn- weight-at
  "Current value of a weight transition {:from :to :start :duration :easing}."
  [{:keys [from to start duration easing]} now]
  (if (or (nil? start) (<= duration 0))
    to
    (let [p (mth/clamp (/ (- now start) duration) 0 1)]
      (+ from (* (- to from) (easing p))))))

(defn set-target
  "Moves the `state` (:hover|:press) weight of `id` towards `target` (0|1)
  from where it is now. `reduce-motion` jumps."
  [weights id state target state-spec now reduce-motion]
  (let [current (if-let [w (get-in weights [id state])] (weight-at w now) 0)
        {:keys [duration easing]} (presets/state-transition state-spec)]
    (assoc-in weights [id state]
              {:from current :to target :start now
               :duration (if reduce-motion 0 duration)
               :easing easing})))

(defn settled?
  [weights now]
  (every? (fn [[_ states]]
            (every? (fn [[_ {:keys [start duration]}]]
                      (or (nil? start) (>= now (+ start duration))))
                    states))
          weights))

(defn- shape-shadow
  [shape]
  (when-let [{:keys [offset-x offset-y blur spread color]}
             (->> (:shadow shape) (remove :hidden) (filter #(= :drop-shadow (:style %))) first)]
    {:offsetX offset-x :offsetY offset-y :blur blur :spread spread
     :color (:color color) :opacity (or (:opacity color) 1)}))

(defn- base-values
  [shape]
  {:opacity 1 :scale 1 :translateX 0 :translateY 0
   :fill (some-> (:fills shape) first :fill-color)
   :shadow (shape-shadow shape)})

(defn- state-values
  "Absolute values of a state spec on top of `base`."
  [shape base {:keys [opacity scale offsetX offsetY fill shadow]}]
  (let [base-opacity (or (:opacity shape) 1)]
    (cond-> base
      (some? opacity) (assoc :opacity (if (pos? base-opacity) (/ opacity base-opacity) 1))
      (some? scale) (assoc :scale scale)
      (some? offsetX) (assoc :translateX offsetX)
      (some? offsetY) (assoc :translateY offsetY)
      (some? fill) (assoc :fill fill)
      (some? shadow) (assoc :shadow (merge {:offsetX 0 :offsetY 0 :blur 0 :spread 0
                                            :color "#000000" :opacity 0.2}
                                           shadow)))))

(defn- lerp-shadow
  [a b t]
  (let [a (or a (assoc b :opacity 0))
        b (or b (assoc a :opacity 0))]
    {:offsetX (mth/lerp (:offsetX a) (:offsetX b) t)
     :offsetY (mth/lerp (:offsetY a) (:offsetY b) t)
     :blur    (mth/lerp (:blur a) (:blur b) t)
     :spread  (mth/lerp (:spread a) (:spread b) t)
     :color   (tl/lerp-value (:color a) (:color b) t)
     :opacity (mth/lerp (:opacity a) (:opacity b) t)}))

(defn- lerp-values
  [a b t]
  (reduce-kv (fn [acc k v]
               (let [from (get a k)]
                 (assoc acc k
                        (cond
                          (= k :shadow) (when (or from v) (lerp-shadow from v t))
                          (nil? from) v
                          (nil? v) from
                          :else (tl/lerp-value from v t)))))
             a
             b))

(defn layer-values
  "Values of one layer for its hover/press weights; nil when at rest."
  [shape states-spec {:keys [hover press]} now]
  (let [wh (if hover (weight-at hover now) 0)
        wp (if press (weight-at press now) 0)]
    (when (or (pos? wh) (pos? wp))
      (let [base   (base-values shape)
            hoverv (state-values shape base (:hover states-spec))
            pressv (state-values shape hoverv (:press states-spec))
            hovered (lerp-values base hoverv wh)
            v      (if (pos? wp)
                     (lerp-values hovered pressv wp)
                     hovered)]
        (cond-> (dissoc v :shadow :fill)
          (and (some? (:shadow v)) (or (:shadow (:hover states-spec)) (:shadow (:press states-spec))))
          (assoc :shadow (:shadow v))
          (and (some? (:fill v)) (or (:fill (:hover states-spec)) (:fill (:press states-spec))))
          (assoc :fill (:fill v)))))))
