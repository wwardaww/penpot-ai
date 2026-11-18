;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.status
  "The chat's working state (W25): while the AI works, an animated
  indicator, the current step in plain words, the elapsed time and Stop;
  while it waits for an answer, a notice; when it is done, how it
  ended."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.util.i18n :as i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn format-elapsed
  "`m:ss` (or `h:mm:ss`) of a duration in milliseconds."
  [ms]
  (let [seconds (js/Math.floor (/ (max 0 ms) 1000))
        hours   (js/Math.floor (/ seconds 3600))
        minutes (js/Math.floor (/ (mod seconds 3600) 60))
        secs    (mod seconds 60)
        pad     #(if (< % 10) (str "0" %) (str %))]
    (if (pos? hours)
      (str hours ":" (pad minutes) ":" (pad secs))
      (str minutes ":" (pad secs)))))

(defn step-text
  "Plain words for a `chat/current-step`."
  [{:keys [type text]}]
  (case type
    :waiting (tr "penforge.chat.status.waiting")
    :writing (tr "penforge.chat.status.writing")
    (:tool :workflow) (or (not-empty text) (tr "penforge.chat.status.working"))
    (tr "penforge.chat.status.thinking")))

(defn- use-now
  "Current time in ms, refreshed every second while `ticking`."
  [ticking]
  (let [now* (mf/use-state (js/Date.now))]
    (mf/with-effect [ticking]
      (when ticking
        (reset! now* (js/Date.now))
        (let [timer (js/setInterval #(reset! now* (js/Date.now)) 1000)]
          #(js/clearInterval timer))))
    (deref now*)))

(defn- stop!
  "Stop what the AI does for the chat: the streaming turn, and the
  workflow runs shown in the timeline."
  [chat]
  (when (= :streaming (:status chat))
    (st/emit! (chat/cancel)))
  (doseq [[run-id run] (:runs chat)]
    (when (and (= :running (:status run)) (not (:silent run)))
      (st/emit! (chat/cancel-workflow run-id)))))

(mf/defc work-status*
  "Status line above the composer. Props: `chat` (the chat state)."
  [{:keys [chat]}]
  (let [;; a question of a silent run (a dialog's or a comment fix's) shows too
        waiting  (chat/waiting? chat)
        working  (or (chat/working? chat) waiting)
        activity (:activity chat)
        now      (use-now working)
        chat-ref (mf/use-ref chat)

        on-stop
        (mf/use-fn #(stop! (mf/ref-val chat-ref)))]

    (mf/set-ref-val! chat-ref chat)

    (cond
      working
      [:div {:class (stl/css-case :status true
                                  :status-working (not waiting)
                                  :status-waiting waiting)
             :role "status"
             :aria-live "polite"
             :data-testid "ai-chat-status"}
       (if waiting
         [:> icon* {:icon-id i/status-alert :size "s" :class (stl/css :status-icon)}]
         [:span {:class (stl/css :dots) :aria-hidden true}
          [:span {:class (stl/css :dot)}]
          [:span {:class (stl/css :dot)}]
          [:span {:class (stl/css :dot)}]])
       [:span {:class (stl/css :status-text)}
        (step-text (chat/current-step chat))]
       ;; the activity belongs to the chat's own work; a silent run has none
       (when-let [started-at (when (chat/working? chat) (:started-at activity))]
         [:span {:class (stl/css :status-time)
                 :aria-label (tr "penforge.chat.status.elapsed")}
          (format-elapsed (- now started-at))])
       (when (chat/working? chat)
         [:> button* {:variant "secondary"
                      :type "button"
                      :class (stl/css :status-stop)
                      :on-click on-stop}
          (tr "penforge.chat.input.stop")])]

      (some? (:outcome activity))
      (let [{:keys [outcome started-at ended-at]} activity
            failed (chat/failed-steps chat)
            partly (and (= outcome :done) (pos? failed))]
        [:div {:class (stl/css-case :status true
                                    :status-ended true
                                    :status-partly partly
                                    :status-failed (contains? #{:error :interrupted} outcome))
               :role "status"
               :data-testid "ai-chat-status"}
         [:> icon* {:icon-id (cond
                               (= outcome :error) i/status-wrong
                               (= outcome :interrupted) i/status-alert
                               (= outcome :cancelled) i/close-small
                               partly i/status-alert
                               :else i/status-tick)
                    :size "s"
                    :class (stl/css :status-icon)}]
         [:span {:class (stl/css :status-text)}
          (cond
            (= outcome :error) (tr "penforge.chat.status.failed")
            (= outcome :interrupted) (tr "penforge.chat.status.interrupted")
            (= outcome :cancelled) (tr "penforge.chat.status.cancelled")
            partly (tr "penforge.chat.status.done-with-errors" (i18n/c failed))
            :else (tr "penforge.chat.status.done"))]
         (when (and started-at ended-at)
           [:span {:class (stl/css :status-time)}
            (format-elapsed (- ended-at started-at))])])

      :else
      nil)))
