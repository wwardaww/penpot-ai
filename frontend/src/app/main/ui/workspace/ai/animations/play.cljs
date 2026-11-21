;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.animations.play
  "Play button of the AI chat's animation steps (W32).

  After a chat turn animates layers with `update_animations`, the
  daemon sends a step line (`chat.tool`, code `animations-set`, params
  `{:node-ids :count :at}`). The line plays the animation once on the
  canvas when it arrives and keeps a Play button to preview it again.
  Playing uses the W31 canvas preview: the file does not change."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.uuid :as uuid]
   [app.main.animations.scene :as scene]
   [app.main.animations.spec :as spec]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.animations.events :as anim]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :as i18n :refer [tr]]
   [rumext.v2 :as mf]))

(def code
  "Code of the daemon's animation step lines."
  "animations-set")

(def autoplay-window-ms
  "A step this young plays by itself when it shows up."
  15000)

(defn step-text
  "Text of a step line: how many layers the turn animated."
  [{layers :count}]
  (tr "penforge.animations.step" (i18n/c (or layers 0))))

(defn step-ids
  "Shape ids (uuids) of a step's `:node-ids` that are on the current
  page (`objects`), in order."
  [objects {:keys [node-ids]}]
  (into []
        (comp (keep uuid/parse*)
              (filter #(contains? objects %)))
        node-ids))

(defn fresh?
  "True when the step was sent less than `autoplay-window-ms` before
  `now` (ms since the epoch)."
  [{:keys [at]} now]
  (let [sent (some-> at js/Date.parse)]
    (and (number? sent)
         (not (js/isNaN sent))
         (<= 0 (- now sent) autoplay-window-ms))))

(defn- state-target
  "First shape of `ids` with a press or hover state: `[id state]`."
  [objects ids]
  (some (fn [id]
          (let [states (:states (spec/get-shape-animations (get objects id)))]
            (cond
              (contains? states :press) [id :press]
              (contains? states :hover) [id :hover])))
        ids))

(defn play-event
  "Event that previews the animations of `ids`: entrances, loops and
  exits; when they have none, the press (or hover) state of the first
  layer that has one. Nil when there is nothing to play."
  [objects ids]
  (when (seq ids)
    (if (seq (:entries (scene/preview-plan objects ids)))
      (anim/play-preview ids)
      (when-let [[id state] (state-target objects ids)]
        (anim/play-state-preview id state)))))

(defonce ^:private played
  ;; ids of the step lines that already played by themselves
  (atom #{}))

(defn- play!
  [ids]
  (let [objects (dsh/lookup-page-objects @st/state)]
    (when-let [event (play-event objects ids)]
      (st/emit! event))))

(mf/defc animation-play*
  "Play button of a chat step line with code `animations-set`."
  [{:keys [entry]}]
  (let [params  (:params entry)
        objects (mf/deref refs/workspace-page-objects)
        ids     (step-ids objects params)
        on-page (seq ids)

        on-click
        (mf/use-fn
         (mf/deps params)
         (fn [_]
           (play! (step-ids (dsh/lookup-page-objects @st/state) params))))]

    (mf/with-effect [(:id entry)]
      (let [id (:id entry)]
        (when (and (not (contains? @played id))
                   (fresh? params (js/Date.now)))
          (swap! played conj id)
          (play! (step-ids (dsh/lookup-page-objects @st/state) params)))))

    [:> button* {:variant "secondary"
                 :type "button"
                 :icon i/play
                 :class (stl/css :play)
                 :disabled (not on-page)
                 :title (when-not on-page (tr "penforge.animations.play-other-page"))
                 :data-testid "penforge-animation-play"
                 :on-click on-click}
     (tr "penforge.animations.play")]))
