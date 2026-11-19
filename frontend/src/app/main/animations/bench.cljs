;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.bench
  "Frame cost of the animation overrides in the workspace canvas, for
  `wiki/research/animation-playback.md`. From the browser console, with a
  board selected:

    app.main.animations.bench.run_bench()

  Renders 60 frames synchronously per case and returns p50/p95 in ms.
  Nothing is committed; the real values are restored at the end."
  (:require
   [app.common.files.helpers :as cfh]
   [app.common.render-wasm.wasm :as wasm]
   [app.main.animations.render :as render]
   [app.main.data.helpers :as dsh]
   [app.main.store :as st]
   [app.render-wasm.api :as api]))

(def ^:private frame-partial 1)
(def ^:private frame-viewport-ready 3)

(defn- render-complete
  "Renders until the frame is complete, like a run of rAF callbacks."
  []
  (let [module wasm/internal-module]
    (loop [pass 0]
      (let [frame-type (.call (unchecked-get module "_render") module 0 (if (zero? pass) 0 1))]
        (when (and (< pass 200)
                   (or (= frame-type frame-partial) (= frame-type frame-viewport-ready)))
          (recur (inc pass)))))
    (when-let [canvas (js/document.getElementById "render")]
      (some-> (.getContext canvas "webgl2") (.finish)))))

(defn- percentile
  [sorted p]
  (nth sorted (min (dec (count sorted)) (js/Math.floor (* p (count sorted))))))

(defn- run-case
  [objects frames values-fn]
  (let [times (loop [i 0 state render/empty-state times []]
                (if (< i frames)
                  (let [t0    (js/performance.now)
                        state (render/apply-frame objects (values-fn (/ i (dec frames))) #{} state)]
                    (render-complete)
                    (recur (inc i) state (conj times (- (js/performance.now) t0))))
                  (do
                    (render/restore objects state)
                    (render-complete)
                    times)))
        sorted (vec (sort times))]
    {:p50 (percentile sorted 0.5)
     :p95 (percentile sorted 0.95)
     :max (peek sorted)}))

(defn run-bench
  "Measures the selected board (or the first selected layer's board)."
  []
  (let [state    @st/state
        objects  (dsh/lookup-page-objects state)
        selected (first (dsh/get-selected-ids state))
        board-id (when selected
                   (if (cfh/frame-shape? (get objects selected))
                     selected
                     (:frame-id (get objects selected))))
        ids      (when board-id (cfh/get-children-ids objects board-id))
        first-id (first (:shapes (get objects board-id)))]
    (if (or (nil? board-id) (not (api/initialized?)))
      #js {:error "select a board first"}
      (do
        (render/set-animation-mode true)
        (let [result
              {:layers (count ids)
               :translate-all (run-case objects 60
                                        (fn [t] (into {} (map (fn [id] [id {:translateY (* 40 (- 1 t))}])) ids)))
               :fade-first-child (run-case objects 60
                                           (fn [t] {first-id {:opacity t}}))
               :slide-fade-first-child (run-case objects 60
                                                 (fn [t] {first-id {:opacity t :translateY (* 24 (- 1 t))}}))}]
          (render/set-animation-mode false)
          (api/request-render "penforge-bench")
          (clj->js result))))))
