;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.animations.driver
  "Frame loop of the Penforge animations. A player belongs to one renderer
  (the workspace canvas, a View mode board) and mixes sources: timed plans
  (entrance, exit, loops, smart animate) and hover/press states. Every
  frame it asks its sources for layer values, writes them as temporary
  render-wasm overrides (`app.main.animations.render`) and asks its
  backend to draw. When the last source ends, the real values come back.

  Backend (map of fns):
    :get-objects  () → objects the overrides refer to
    :draw         () → draws after a frame was written
    :begin / :end () → around a playing run (optional)
    :interrupted? (objects) → true to stop (optional)

  Source (map):
    :values   (fn [now]) → {layer-id values}
    :absolute set of ids with absolute matrices (optional)
    :done?    (fn [now]) → true when it ended (optional, default never)
    :hold     true keeps its last values after it ended (optional)
    :on-done  (fn []) called once when it ended (optional)"
  (:require
   [app.common.logging :as log]
   [app.main.animations.render :as render]
   [app.main.animations.scene :as scene]
   [app.main.animations.timeline :as tl]))

(defonce ^:private players (atom {}))

(defn- now-ms
  []
  (js/performance.now))

(defn- collect
  [sources now]
  (reduce (fn [acc [_ {:keys [values absolute]}]]
            (-> acc
                (update :values #(merge-with tl/combine % (values now)))
                (update :absolute into absolute)))
          {:values {} :absolute #{}}
          sources))

(declare ^:private schedule)

(defn- finish
  [key]
  (when-let [{:keys [backend render-state]} (get @players key)]
    (let [{:keys [get-objects draw end]} backend]
      (try
        (when (render/renderer-ready?)
          (render/restore (get-objects) render-state)
          (when end (end))
          (draw))
        (catch :default cause
          (log/error :hint "animation restore failed" :cause cause))))
    (swap! players dissoc key)))

(defn- tick
  [key]
  (let [player (get @players key)]
    (when (some? player)
      (let [{:keys [backend sources render-state objects persistent]} player
            {:keys [get-objects draw interrupted?]} backend
            current (get-objects)
            now     (now-ms)]
        (cond
          (not (render/renderer-ready?))
          (swap! players dissoc key)

          (or (and (some? interrupted?) (interrupted? current))
              (and (some? objects) (not (identical? objects current)) (not persistent)))
          (finish key)

          :else
          (let [{:keys [values absolute]} (collect sources now)
                new-state (try
                            (render/apply-frame current values absolute render-state)
                            (catch :default cause
                              (log/error :hint "animation frame failed" :cause cause)
                              nil))
                ended     (into []
                                (filter (fn [[_ {:keys [done? ended]}]]
                                          (and (not ended) (some? done?) (done? now))))
                                sources)]
            (if (nil? new-state)
              (finish key)
              (do
                (draw)
                (swap! players update key
                       (fn [p]
                         (when p
                           (let [p (assoc p :render-state new-state :objects current)]
                             (reduce (fn [p [skey {:keys [hold]}]]
                                       (if hold
                                         (assoc-in p [:sources skey :ended] true)
                                         (update p :sources dissoc skey)))
                                     p
                                     ended)))))
                (doseq [[_ {:keys [on-done]}] ended]
                  (when on-done (on-done)))
                (let [p (get @players key)]
                  (cond
                    (nil? p) nil
                    (and (empty? (:sources p)) (not (:persistent p))) (finish key)
                    (empty? (:sources p))
                    (do
                      ;; Persistent player at rest: give the real values
                      ;; back and wait for the next source.
                      (render/restore current (:render-state p))
                      (draw)
                      (swap! players update key assoc :render-state render/empty-state :raf nil))
                    :else (schedule key)))))))))))

(defn- schedule
  [key]
  (let [id (js/requestAnimationFrame (fn [_] (tick key)))]
    (swap! players update key assoc :raf id)))

(defn play
  "Adds (or replaces) `source` under `source-key` on the player `key`,
  creating the player with `backend` when needed. `persistent` players
  (View mode) stay registered while idle."
  ([key backend source-key source]
   (play key backend source-key source false))
  ([key backend source-key source persistent]
   (let [existing (get @players key)]
     (when (and (nil? existing) (:begin backend))
       ((:begin backend)))
     (swap! players
            (fn [ps]
              (-> ps
                  (update key (fn [p]
                                (or p {:key key
                                       :backend backend
                                       :persistent persistent
                                       :render-state render/empty-state
                                       :sources {}})))
                  (assoc-in [key :sources source-key] source))))
     (when (nil? (get-in @players [key :raf]))
       (schedule key)))))

(defn stop-source
  [key source-key]
  (swap! players (fn [ps] (cond-> ps (contains? ps key) (update-in [key :sources] dissoc source-key))))
  (when (and (some? (get @players key)) (nil? (get-in @players [key :raf])))
    (schedule key)))

(defn stop
  "Stops the player `key` at once and restores the real values."
  [key]
  (when-let [raf (get-in @players [key :raf])]
    (js/cancelAnimationFrame raf))
  (finish key))

(defn playing?
  [key]
  (seq (get-in @players [key :sources])))

(defn has-source?
  [key source-key]
  (contains? (get-in @players [key :sources]) source-key))

;; --- Sources

(defn plan-source
  "Source of timed `entries` (see `app.main.animations.scene`) starting now."
  ([entries] (plan-source entries {}))
  ([entries {:keys [absolute hold on-done]}]
   (let [start (now-ms)]
     {:values (fn [now] (scene/sample entries (- now start)))
      :absolute (or absolute #{})
      :done? (fn [now] (scene/finished? entries (- now start)))
      :hold hold
      :on-done on-done})))
