;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.qa.events
  "Visual QA (W18): compare the running app with the design boards
  (`visual-qa` daemon workflow), let Claude fix the differences, and
  the `:ai/visual-qa` action.

  State lives under `[:penforge :qa]`:

  - `:status` `:idle` `:running` `:done` `:error`
  - `:mode` `:check` (compare only) or `:fix` (compare, then fix)
  - `:rid` request id of the current run, `:run-id` once started
  - `:progress` last `progress` payload with a `:step`
    (`{:step :params :text}`); `:activity` last Claude tool line
  - `:result` result payload of the last check or fix (screens with
    scores and preview images)
  - `:settings` `{:threshold :max-iterations :auto-run-after-build}`
  - `:auto` true for a run started by a finished build
  - `:skipped` true when an automatic run was skipped (setting off)
  - `:accepted` run name of the accepted result
  - `:summary` / `:error` / `:error-code` from `workflow.done`, the
    `failed` event or the request error

  `apply-run-message` is the pure reducer of the run's messages."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def workflow-name "visual-qa")

(def panel-type
  "Modal type of the report panel (`app.main.ui.workspace.ai.qa.panel`)."
  :penforge-qa)

(def built-event
  "Data event of a successful build (W08 `build.events/built`)."
  :app.main.ui.workspace.ai.build.events/built)

;; --- Pure helpers

(defn apply-run-message
  "Reduce a daemon message of the current run into the QA state."
  [qa {:keys [type kind payload] :as msg}]
  (case type
    "workflow.started"
    (assoc qa :run-id (:run-id msg))

    "workflow.event"
    (cond
      (and (= kind "progress") (:step payload))
      (assoc qa :progress payload)

      (= kind "progress")
      (assoc qa :activity (:summary payload))

      (= kind "failed")
      (assoc qa :error-code (:code payload) :error (:message payload))

      (and (= kind "result") (:skipped payload))
      (assoc qa :skipped true :settings (:settings payload))

      (and (= kind "result") (= "accept" (:mode payload)))
      (assoc qa :accepted (:run-name payload))

      (and (= kind "result") (= "settings" (:mode payload)))
      (assoc qa :settings (:settings payload))

      (= kind "result")
      (assoc qa :result payload :settings (:settings payload))

      :else
      qa)

    "workflow.done"
    (-> qa
        (assoc :status (if (:ok msg) :done :error)
               :summary (:summary msg))
        (cond-> (and (not (:ok msg)) (nil? (:error qa)))
          (assoc :error (:error msg)))
        (dissoc :progress :activity))

    "error"
    (-> qa
        (assoc :status :error
               :error (:message msg)
               :error-code (:code msg))
        (dissoc :progress :activity))

    qa))

(defn running?
  [qa]
  (= :running (:status qa)))

(defn failing-board-ids
  "Board ids of the screens of a result that do not match yet."
  [result]
  (into [] (comp (remove :passed) (map :board-id)) (:screens result)))

(defn match-counts
  "`[matching total]` screens of a result."
  [result]
  (let [screens (:screens result)]
    [(count (filter :passed screens)) (count screens)]))

(defn- start-run
  [qa mode rid {:keys [trigger]}]
  (-> qa
      (assoc :status :running
             :mode mode
             :rid rid
             :run-id nil
             :auto (= trigger "build"))
      (dissoc :summary :error :error-code :progress :activity :skipped)))

;; --- Events

(defn get-qa
  [state]
  (get-in state [:penforge :qa] {:status :idle}))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- run-message
  [rid msg]
  (ptk/reify ::run-message
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (:rid (get-qa state)))
        (update-in state [:penforge :qa] apply-run-message msg)
        state))))

(defn open-panel
  []
  (modal/show panel-type {}))

(defn- report-auto-run
  "After an automatic check (after a build): show the report, or a toast
  with a link to it when another dialog (the build dialog) is open."
  []
  (ptk/reify ::report-auto-run
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [result skipped status]} (get-qa state)]
        (cond
          (or skipped (not= status :done) (nil? result))
          (rx/empty)

          (nil? (::modal/modal state))
          (rx/of (open-panel))

          :else
          (let [[matching total] (match-counts result)]
            (rx/of (ntf/show {:content (tr "penforge.qa.auto-done" matching total)
                              :level (if (= matching total) :success :warning)
                              :type :toast
                              :position :fixed
                              :timeout 15000
                              :links [{:label (tr "penforge.qa.open-report")
                                       :callback #(st/emit! (ntf/hide) (open-panel))}]}))))))))

(defn- start
  [mode params]
  (let [rid (proto/next-rid)]
    (ptk/reify ::start
      ptk/UpdateEvent
      (update [_ state]
        (let [qa (get-qa state)]
          (cond
            (running? qa)
            state

            (not (connected? state))
            (assoc-in state [:penforge :qa]
                      (-> (start-run qa mode rid params)
                          (assoc :status :error :error-code "not-connected")))

            :else
            (assoc-in state [:penforge :qa] (start-run qa mode rid params)))))

      ptk/WatchEvent
      (watch [_ state stream]
        (let [qa (get-qa state)]
          (if (and (= rid (:rid qa)) (running? qa))
            (rx/merge
             (rx/concat
              (->> (chat/workflow-messages stream rid)
                   (rx/map (partial run-message rid)))
              (if (:auto qa)
                (rx/of (report-auto-run))
                (rx/empty)))
             (rx/of (chat/run-workflow workflow-name
                                       (assoc params :mode (name mode))
                                       {:rid rid :silent true})))
            (rx/empty)))))))

(defn check
  "Compare the app with the design (all screens, or `:board-ids`)."
  ([] (check nil))
  ([{:keys [board-ids]}]
   (start :check (cond-> {}
                   (seq board-ids) (assoc :board-ids (vec board-ids))))))

(defn fix
  "Compare, then let Claude fix the screens below the threshold
  (all screens, or `:board-ids`)."
  ([] (fix nil))
  ([{:keys [board-ids]}]
   (start :fix (cond-> {}
                 (seq board-ids) (assoc :board-ids (vec board-ids))))))

(defn keep-fixing
  "Fix again the screens of the last result that do not match yet."
  []
  (ptk/reify ::keep-fixing
    ptk/WatchEvent
    (watch [_ state _]
      (let [board-ids (failing-board-ids (:result (get-qa state)))]
        (if (seq board-ids)
          (rx/of (fix {:board-ids board-ids}))
          (rx/empty))))))

(defn auto-check
  "Check after a finished build; the daemon skips it unless the project
  turned it on."
  []
  (ptk/reify ::auto-check
    ptk/WatchEvent
    (watch [_ state _]
      (if (and (connected? state) (not (running? (get-qa state))))
        (rx/of (start :check {:trigger "build"}))
        (rx/empty)))))

(defn- run-side-workflow
  "Run a short `visual-qa` mode (settings, accept) that does not replace
  the current run; its result is reduced into the QA state."
  [params]
  (let [rid (proto/next-rid)]
    (ptk/reify ::run-side-workflow
      ptk/WatchEvent
      (watch [_ _ stream]
        (rx/merge
         (->> (chat/workflow-messages stream rid)
              (rx/filter #(and (= "workflow.event" (:type %)) (= "result" (:kind %))))
              (rx/map (fn [msg]
                        (ptk/reify ::side-result
                          ptk/UpdateEvent
                          (update [_ state]
                            (update-in state [:penforge :qa]
                                       (fnil apply-run-message {:status :idle})
                                       msg))))))
         (rx/of (chat/run-workflow workflow-name params {:rid rid :silent true})))))))

(defn set-auto-run
  "Turn the check after every build on or off for the project."
  [enabled]
  (run-side-workflow {:mode "settings"
                      :settings {:auto-run-after-build (boolean enabled)}}))

(defn accept
  "Accept the last result as it is and close the panel."
  []
  (ptk/reify ::accept
    ptk/WatchEvent
    (watch [_ state _]
      (let [run-name (get-in (get-qa state) [:result :run-name])]
        (rx/concat
         (if run-name
           (rx/of (run-side-workflow {:mode "accept" :run-name run-name}))
           (rx/empty))
         (rx/of (modal/hide)))))))

(defn cancel
  "Stop the running check or fix."
  []
  (ptk/reify ::cancel
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [run-id] :as qa} (get-qa state)]
        (if (and (running? qa) run-id)
          (rx/of (chat/cancel-workflow run-id))
          (rx/empty))))))

;; --- Check after every build

(defonce build-watch
  ;; W08 emits `built` when a build succeeds; the daemon decides
  ;; whether the project wants a check then
  (->> st/stream
       (rx/filter (ptk/type? built-event))
       (rx/subs! (fn [_] (st/emit! (auto-check))))))

;; --- Action

(actions/register-action!
 {:id :ai/visual-qa
  :label #(tr "penforge.actions.visual-qa")
  :icon i/boards-thumbnail
  :order 92
  :scopes #{:main-menu :command-palette}
  :run (fn [_]
         (st/emit! (open-panel) (check)))})
