;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.presets
  "Compiles animation spec sections into clips: tracks of keyframes over a
  duration. Presets (entrance/exit effects, loops) are generated keyframes,
  so a later keyframe editor stores `tracks` directly in the same format.

  Clip:
    {:delay ms :duration ms :iterations n|##Inf :easing f
     :tracks [{:prop kw :keyframes [{:at 0..1 :value v :easing f?}]}]}

  Track props: :opacity (factor), :translateX/:translateY (px), :scale,
  :scaleX/:scaleY (factors), :rotate (deg), :blur (px), :fill (#hex),
  :radius (px), :shimmer (0..1 sweep position)."
  (:require
   [app.main.animations.easing :as ease]))

(def default-duration 300)
(def default-distance 24)
(def default-scale-from 0.8)
(def default-blur 8)

(def identity-values
  {:opacity 1 :translateX 0 :translateY 0 :scale 1 :scaleX 1 :scaleY 1
   :rotate 0 :blur 0})

(defn- effect-hidden-values
  "Values of the hidden end of an effect. `exit?` flips the slide so the
  direction always names where the layer moves."
  [{:keys [type direction distance from amount]} exit?]
  (case type
    "fade"  {:opacity 0}
    "scale" {:scale (or from default-scale-from)}
    "blur"  {:blur (or amount default-blur)}
    "slide" (let [d (or distance default-distance)
                  d (if exit? (- d) d)]
              (case (or direction "up")
                "up"    {:translateY d}
                "down"  {:translateY (- d)}
                "left"  {:translateX d}
                "right" {:translateX (- d)}))
    {}))

(defn- keyframes
  [from to]
  [{:at 0 :value from} {:at 1 :value to}])

(defn- spec-tracks
  "Spec `tracks` (JSON) to clip tracks: keyword props and easing fns."
  [tracks]
  (mapv (fn [{:keys [prop keyframes]}]
          {:prop (keyword prop)
           :keyframes (->> keyframes
                           (sort-by :at)
                           (mapv (fn [{:keys [at value easing]}]
                                   (cond-> {:at at :value value}
                                     (some? easing) (assoc :easing (ease/get-easing easing))))))})
        tracks))

(defn motion-clip
  "Clip of an entrance (`kind` :entrance) or exit (:exit) motion."
  [{:keys [effects tracks duration delay easing]} kind]
  (let [exit?  (= kind :exit)
        hidden (reduce merge {} (map #(effect-hidden-values % exit?) effects))
        tracks (if (seq tracks)
                 (spec-tracks tracks)
                 (mapv (fn [[prop value]]
                         (let [shown (get identity-values prop)]
                           {:prop prop
                            :keyframes (if exit?
                                         (keyframes shown value)
                                         (keyframes value shown))}))
                       hidden))]
    {:kind kind
     :delay (or delay 0)
     :duration (ease/get-duration easing (or duration default-duration))
     :iterations 1
     :easing (ease/get-easing easing (if exit? "ease-in" "ease-out"))
     :tracks tracks}))

(def loop-defaults
  {"pulse"   {:duration 1000}
   "spin"    {:duration 1000}
   "bounce"  {:duration 800}
   "shimmer" {:duration 1200}})

(defn- loop-tracks
  [type intensity]
  (let [i         (or intensity 1)
        in-out    (ease/get-easing "ease-in-out")]
    (case type
      "pulse"
      [{:prop :scale
        :keyframes [{:at 0 :value 1}
                    {:at 0.5 :value (+ 1 (* 0.06 i)) :easing in-out}
                    {:at 1 :value 1 :easing in-out}]}
       {:prop :opacity
        :keyframes [{:at 0 :value 1}
                    {:at 0.5 :value (max 0 (- 1 (* 0.15 i))) :easing in-out}
                    {:at 1 :value 1 :easing in-out}]}]

      "spin"
      [{:prop :rotate :keyframes (keyframes 0 (* 360 (max 1 (js/Math.round i))))}]

      "bounce"
      [{:prop :translateY
        :keyframes [{:at 0 :value 0}
                    {:at 0.5 :value (* -8 i) :easing (ease/get-easing "ease-out")}
                    {:at 1 :value 0 :easing (ease/get-easing "ease-in")}]}]

      "shimmer"
      [{:prop :shimmer :keyframes (keyframes 0 1)}])))

(defn loop-clip
  [{:keys [type duration count delay easing intensity]}]
  {:kind :loop
   :delay (or delay 0)
   :duration (or duration (get-in loop-defaults [type :duration]))
   :iterations (if (or (nil? count) (= "infinite" count)) ##Inf count)
   :easing (ease/get-easing easing "linear")
   :tracks (loop-tracks type intensity)})

(defn state-transition
  "Duration (ms) and easing fn of a hover/press state."
  [{:keys [duration easing]}]
  {:duration (ease/get-duration easing (or duration 150))
   :easing (ease/get-easing easing "ease-out")})
