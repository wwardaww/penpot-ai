;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.easing
  "Easing functions for the Penforge animation driver: Penpot's named
  easings (CSS cubic-bezier curves) and a damped spring."
  (:require
   [app.common.math :as mth]))

(defn- bezier-coord
  [p1 p2 t]
  (let [u (- 1 t)]
    (+ (* 3 u u t p1) (* 3 u t t p2) (* t t t))))

(defn- bezier-slope
  [p1 p2 t]
  (let [u (- 1 t)]
    (+ (* 3 u u p1) (* 6 u t (- p2 p1)) (* 3 t t (- 1 p2)))))

(defn cubic-bezier
  "CSS `cubic-bezier(x1, y1, x2, y2)` as a function of progress 0..1."
  [x1 y1 x2 y2]
  (fn [x]
    (cond
      (<= x 0) 0
      (>= x 1) 1
      :else
      ;; Newton iterations on x(t) = x, then bisection as a fallback.
      (let [t (loop [t x i 0]
                (let [err   (- (bezier-coord x1 x2 t) x)
                      slope (bezier-slope x1 x2 t)]
                  (cond
                    (< (mth/abs err) 1e-6) t
                    (or (>= i 8) (< (mth/abs slope) 1e-6)) nil
                    :else (recur (- t (/ err slope)) (inc i)))))
            t (or t
                  (loop [lo 0 hi 1 i 0]
                    (let [mid (/ (+ lo hi) 2)]
                      (if (>= i 30)
                        mid
                        (if (< (bezier-coord x1 x2 mid) x)
                          (recur mid hi (inc i))
                          (recur lo mid (inc i)))))))]
        (bezier-coord y1 y2 t)))))

(def linear identity)

(def named
  {"linear"      linear
   "ease"        (cubic-bezier 0.25 0.1 0.25 1)
   "ease-in"     (cubic-bezier 0.42 0 1 1)
   "ease-out"    (cubic-bezier 0 0 0.58 1)
   "ease-in-out" (cubic-bezier 0.42 0 0.58 1)})

(def spring-defaults
  {:stiffness 170 :damping 26 :mass 1})

(defn- spring-position
  "Position of a damped spring going from 0 to 1, at `t` seconds."
  [stiffness damping mass t]
  (let [w0   (mth/sqrt (/ stiffness mass))
        zeta (/ damping (* 2 (mth/sqrt (* stiffness mass))))]
    (cond
      (< zeta 1)
      (let [wd (* w0 (mth/sqrt (- 1 (* zeta zeta))))]
        (- 1 (* (js/Math.exp (- (* zeta w0 t)))
                (+ (mth/cos (* wd t))
                   (* (/ (* zeta w0) wd) (mth/sin (* wd t)))))))

      (= zeta 1)
      (- 1 (* (js/Math.exp (- (* w0 t))) (+ 1 (* w0 t))))

      :else
      (let [s  (mth/sqrt (- (* zeta zeta) 1))
            r1 (* w0 (- (- zeta) s))
            r2 (* w0 (+ (- zeta) s))
            c2 (/ r1 (- r1 r2))
            c1 (- -1 c2)]
        (+ 1 (* c1 (js/Math.exp (* r1 t))) (* c2 (js/Math.exp (* r2 t))))))))

(defn spring-duration
  "Milliseconds until the spring settles (stays within 0.1% of the end),
  clamped to 50..5000."
  [{:keys [stiffness damping mass]}]
  (let [{:keys [stiffness damping mass]}
        (merge spring-defaults
               (cond-> {}
                 stiffness (assoc :stiffness stiffness)
                 damping   (assoc :damping damping)
                 mass      (assoc :mass mass)))
        step 0.01
        ;; Last sampled time where the spring was still away from the end.
        last-out
        (reduce (fn [acc t]
                  (if (> (mth/abs (- 1 (spring-position stiffness damping mass t))) 0.001)
                    t
                    acc))
                0
                (range 0 5 step))]
    (-> (* 1000 (+ last-out step))
        (max 50)
        (min 5000)
        (mth/round))))

(defn spring
  "Spring easing over its own settle time: progress 0..1 → position."
  [{:keys [stiffness damping mass] :as opts}]
  (let [{:keys [stiffness damping mass]}
        (merge spring-defaults
               (cond-> {}
                 stiffness (assoc :stiffness stiffness)
                 damping   (assoc :damping damping)
                 mass      (assoc :mass mass)))
        seconds (/ (spring-duration opts) 1000)]
    (fn [p]
      (cond
        (<= p 0) 0
        (>= p 1) 1
        :else (spring-position stiffness damping mass (* p seconds))))))

(defn spring?
  [easing]
  (and (map? easing) (= "spring" (:type easing))))

(defn get-easing
  "Easing function for a spec easing value (name or spring map); defaults
  to `default` (a name) when nil or unknown."
  ([easing] (get-easing easing "ease"))
  ([easing default]
   (cond
     (spring? easing) (spring easing)
     (contains? named easing) (get named easing)
     :else (get named default linear))))

(defn get-duration
  "Duration in ms of a motion: springs define their own."
  [easing duration]
  (if (spring? easing)
    (spring-duration easing)
    duration))
