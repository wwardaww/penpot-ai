;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.build
  "AI actions of the build and preview flow (W09): the primary Build
  button, which opens the Build dialog (W08), and the preview toggle.

  W34: once an app is built, the Build button turns into Update, with a
  badge counting the design changes since the last build; it is
  disabled (\"Up to date\") when nothing changed. Update opens the
  dialog on the change list. \"Update with instructions…\" opens it
  too, so new instructions for the AI can go in without a design
  change.

  W41: the Build button of the floating toolbar is a split button; its
  dropdown also offers Instruct, which writes a specification without
  code."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.preview :as preview]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.main.ui.workspace.ai.build.instruct :as instruct]
   [app.util.i18n :refer [tr]]))

(defn building?
  "Whether a build (plan or generation) is running."
  [state]
  (build/running? (build/get-build state)))

(defn get-cta
  "Mode of the Build button: `:build`, `:update` or `:up-to-date`."
  [state]
  (build/get-cta (build/get-changes state)))

(defn get-build-label
  "Label of the Build button for the app state."
  [state]
  (case (get-cta state)
    :update (tr "penforge.build.update")
    :up-to-date (tr "penforge.build.up-to-date")
    (tr "penforge.build")))

(defn get-build-badge
  "Badge of the Build button: the number of changes in Update mode."
  [state]
  (when (= :update (get-cta state))
    (let [n (build/get-change-count (build/get-changes state))]
      (when (pos? n) (str n)))))

(defn build-enabled?
  "The Build button is disabled while a build runs and, in Update mode,
  when nothing changed."
  [state]
  (and (not (building? state))
       (not= :up-to-date (get-cta state))))

(actions/register-action!
 {:id :ai/build
  :label #(get-build-label @st/state)
  :badge get-build-badge
  :icon i/play
  :primary true
  :order 90
  :scopes #{:island :main-menu :command-palette}
  :visible? (fn [state] (not (#{:game :existing} (get-in state [:penforge-project-settings (:current-project-id state)]))))
  :enabled? build-enabled?
  :run (fn [{:keys [state]}]
         (if (= :build (get-cta state))
           (st/emit! (build/start))
           (st/emit! (build/start-update))))})

(defn instructing?
  "Whether an Instruct run (plan or export) is going on."
  [state]
  (instruct/running? (instruct/get-instruct state)))

(actions/register-action!
 {:id :ai/instruct
  :label #(tr "penforge.instruct.action")
  :icon i/document
  :order 91
  :split-of :ai/build
  :scopes #{:island :main-menu :command-palette}
  ;; like Build: not for Game UI and Existing projects
  :visible? (fn [state]
              (let [build-action (get @actions/registry :ai/build)]
                (boolean (and (some? build-action)
                              ((:visible? build-action) state)))))
  ;; a running export can be shown again
  :enabled? (fn [state] (not (building? state)))
  :run (fn [_]
         (st/emit! (instruct/start)))})

(actions/register-action!
 {:id :ai/build-instructions
  :label #(tr "penforge.actions.build-instructions")
  :icon i/play
  :order 92
  :scopes #{:main-menu :command-palette}
  ;; shown with Update, and hidden wherever the Build button is hidden
  :visible? (fn [state]
              (and (not= :build (get-cta state))
                   (let [build-action (get @actions/registry :ai/build)]
                     (and (some? build-action)
                          (seq (actions/get-actions {:ai/build build-action} :main-menu state))))))
  :enabled? (fn [state] (not (building? state)))
  :run (fn [_]
         (st/emit! (build/start-update)))})

(actions/register-action!
 {:id :ai/preview
  :label #(tr "penforge.preview.toggle")
  :icon i/shown
  :order 91
  :scopes #{:header :main-menu :command-palette}
  :run (fn [_]
         (st/emit! (preview/toggle-pane)))})
