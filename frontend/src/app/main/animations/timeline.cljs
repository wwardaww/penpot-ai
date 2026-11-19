;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.timeline
  "Pure sampling of clips (`app.main.animations.presets`) at a time, and
  the rules to combine the values of several clips on one layer."
  (:require
   [app.common.math :as mth]
   [app.common.types.color :as clr]))

(defn clip-progress
  "Progress 0..1 (before easing) of `clip` at `elapsed` ms since the clip
  was scheduled. Before the delay it holds 0 (the first keyframe shows),
  after the last iteration it holds 1."
  [{:keys [delay duration iterations]} elapsed]
  (let [local (- elapsed delay)]
    (cond
      (neg? local) 0
      (<= duration 0) 1
      :else
      (let [cycles (/ local duration)]
        (if (>= cycles iterations)
          1
          (- cycles (js/Math.floor cycles)))))))

(defn clip-done?
  [{:keys [delay duration iterations]} elapsed]
  (and (not (infinite? iterations))
       (>= elapsed (+ delay (* duration iterations)))))

(defn clip-end
  "Elapsed ms when the clip ends; ##Inf for endless loops."
  [{:keys [delay duration iterations]}]
  (if (infinite? iterations)
    ##Inf
    (+ delay (* duration iterations))))

(defn- lerp-color
  [from to t]
  (let [[r1 g1 b1] (clr/hex->rgb from)
        [r2 g2 b2] (clr/hex->rgb to)
        t (mth/clamp t 0 1)
        ch (fn [a b] (-> (mth/lerp a b t) (js/Math.round) (mth/clamp 0 255)))]
    (clr/rgb->hex [(ch r1 r2) (ch g1 g2) (ch b1 b2)])))

(defn lerp-value
  [from to t]
  (if (string? from)
    (lerp-color from (if (string? to) to from) t)
    (mth/lerp from to t)))

(defn sample-keyframes
  "Value of a keyframe list at eased progress `p` (may go outside 0..1
  with springs: numbers extrapolate on the end segments)."
  [keyframes p]
  (let [n (count keyframes)
        first-kf (nth keyframes 0)]
    (if (= n 1)
      (:value first-kf)
      (let [idx (loop [i 0]
                  (if (and (< i (- n 2)) (> p (:at (nth keyframes (inc i)))))
                    (recur (inc i))
                    i))
            a   (nth keyframes idx)
            b   (nth keyframes (inc idx))
            span (- (:at b) (:at a))
            local (if (pos? span) (/ (- p (:at a)) span) 1)
            local (if-let [seg-easing (:easing b)]
                    (seg-easing (mth/clamp local 0 1))
                    local)]
        (lerp-value (:value a) (:value b) local)))))

(defn sample-clip
  "Map prop → value of `clip` at `elapsed` ms."
  [{:keys [easing tracks] :as clip} elapsed]
  (let [p (clip-progress clip elapsed)
        p (if easing (easing p) p)]
    (reduce (fn [acc {:keys [prop keyframes]}]
              (assoc acc prop (sample-keyframes keyframes p)))
            {}
            tracks)))

(def ^:private multiply-props #{:opacity :scale :scaleX :scaleY})
(def ^:private add-props #{:translateX :translateY :rotate})

(defn combine
  "Merge the values of two clips on one layer: factors multiply, offsets
  add, blur takes the larger, colors/shimmer/radius: the later wins."
  [a b]
  (reduce-kv (fn [acc k v]
               (let [prev (get acc k)]
                 (assoc acc k
                        (cond
                          (nil? prev) v
                          (contains? multiply-props k) (* prev v)
                          (contains? add-props k) (+ prev v)
                          (= k :blur) (max prev v)
                          :else v))))
             a
             b))

(defn order-children
  "Children ids of a stagger in play order: visual reading order (top to
  bottom, then left to right) and `from` first|last|center."
  [objects child-ids from]
  (let [ordered (->> child-ids
                     (keep #(get objects %))
                     (remove :hidden)
                     (sort-by (fn [{:keys [selrect]}]
                                [(js/Math.round (:y selrect)) (:x selrect)]))
                     (mapv :id))]
    (case from
      "last" (vec (reverse ordered))
      "center"
      (let [n   (count ordered)
            mid (/ (dec n) 2)]
        (->> ordered
             (map-indexed vector)
             (sort-by (fn [[i _]] (mth/abs (- i mid))))
             (mapv second)))
      ordered)))

(defn stagger-delays
  "Map child id → extra delay ms for a stagger: index × each. With `from`
  center, children at the same distance from the middle start together."
  [objects child-ids {:keys [each from]}]
  (if (= from "center")
    (let [ordered (order-children objects child-ids "first")
          mid     (/ (dec (count ordered)) 2)]
      (into {} (map-indexed (fn [i id]
                              [id (* each (js/Math.floor (mth/abs (- i mid))))])
                            ordered)))
    (into {} (map-indexed (fn [i id] [id (* i each)])
                          (order-children objects child-ids from)))))
