;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.animations.events
  "Penforge animations in the workspace (W31): edit the spec stored in the
  shape plugin data (one undo step) and preview it on the canvas without
  changing the file."
  (:require
   [app.common.files.changes-builder :as pcb]
   [app.main.animations.driver :as driver]
   [app.main.animations.presets :as presets]
   [app.main.animations.render :as render]
   [app.main.animations.scene :as scene]
   [app.main.animations.spec :as spec]
   [app.main.animations.states :as states]
   [app.main.data.changes :as dch]
   [app.main.data.helpers :as dsh]
   [app.main.store :as st]
   [app.render-wasm.api :as api]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

;; --- Edit

(defn get-changes
  "Changes that store `(update-fn spec)` on every shape of `ids` (a shape
  without spec starts from an empty one). Shapes whose stored value does
  not change are skipped."
  [changes objects page-id ids update-fn]
  (reduce (fn [changes id]
            (if-let [shape (get objects id)]
              (let [current (or (spec/get-shape-animations shape) (spec/empty-spec))
                    value   (spec/encode (update-fn current))]
                (if (= value (spec/get-stored-value shape))
                  changes
                  (pcb/set-plugin-data changes :shape id page-id
                                       spec/plugin-namespace spec/plugin-key value)))
              changes))
          changes
          ids))

(defn update-animations
  "Applies `update-fn` (spec → spec) to the animation spec of the shapes
  `ids` of the current page, as one undo step. A spec that ends up empty
  removes the plugin data entry."
  [ids update-fn]
  (ptk/reify ::update-animations
    ptk/WatchEvent
    (watch [it state _]
      (let [page-id   (:current-page-id state)
            objects   (dsh/lookup-page-objects state page-id)
            file-data (dsh/lookup-file-data state)
            changes   (-> (pcb/empty-changes it page-id)
                          (pcb/with-file-data file-data)
                          (get-changes objects page-id ids update-fn))]
        (if (seq (:redo-changes changes))
          (rx/of (dch/commit-changes changes))
          (rx/empty))))))

;; --- Canvas preview

(def ^:private player-key :workspace)

(defn- workspace-backend
  []
  {:get-objects #(dsh/lookup-page-objects @st/state)
   :draw #(api/request-render "penforge-animation")
   :begin #(render/set-animation-mode true)
   :end #(render/set-animation-mode false)})

(defn stop-preview
  []
  (ptk/reify ::stop-preview
    ptk/EffectEvent
    (effect [_ _ _]
      (driver/stop player-key))))

(defn play-preview
  "Plays the entrance, loops and exit of `ids` (and their descendants) on
  the canvas. The file does not change."
  [ids]
  (ptk/reify ::play-preview
    ptk/EffectEvent
    (effect [_ state _]
      (when (render/renderer-ready?)
        (let [objects (dsh/lookup-page-objects state)
              {:keys [entries]} (scene/preview-plan objects ids)]
          (driver/stop player-key)
          (when (seq entries)
            (driver/play player-key (workspace-backend) :preview
                         (driver/plan-source entries))))))))

(def state-preview-hold 500)

(defn- state-weight
  "Weight of a state preview at `elapsed`: in, hold, out."
  [{:keys [duration easing]} elapsed]
  (let [out-start (+ duration state-preview-hold)]
    (cond
      (<= duration 0) (if (< elapsed state-preview-hold) 1 0)
      (< elapsed duration) (easing (/ elapsed duration))
      (< elapsed out-start) 1
      (< elapsed (+ out-start duration)) (- 1 (easing (/ (- elapsed out-start) duration)))
      :else 0)))

(defn play-state-preview
  "Shows the hover or press `state` of the shape `id` and goes back."
  [id state]
  (ptk/reify ::play-state-preview
    ptk/EffectEvent
    (effect [_ st _]
      (when (render/renderer-ready?)
        (let [objects (dsh/lookup-page-objects st)
              shape   (get objects id)
              anim    (spec/get-shape-animations shape)
              st-spec (get-in anim [:states state])]
          (when (some? st-spec)
            (let [transition (presets/state-transition st-spec)
                  total      (+ (* 2 (:duration transition)) state-preview-hold)
                  start      (js/performance.now)]
              (driver/stop player-key)
              (driver/play player-key (workspace-backend) :preview
                           {:values (fn [now]
                                      (let [w (state-weight transition (- now start))
                                            v (states/layer-values shape (:states anim)
                                                                   {state {:to w}} now)]
                                        (if v {id v} {})))
                            :done? (fn [now] (>= (- now start) total))}))))))))
