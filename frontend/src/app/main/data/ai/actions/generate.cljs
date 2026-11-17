;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.generate
  "Generate a screen from a prompt (W13): the `:ai/generate-screen`
  action opens the prompt dialog, which starts the daemon workflow
  `generate-screen`. When the run reports its result the new board is
  selected and zoomed to."
  (:require
   [app.common.data :as d]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.helpers :as dsh]
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   ;; registers the dialog in the modal registry
   [app.main.ui.workspace.ai.generate.dialog]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def workflow-name "generate-screen")

(defn workflow-params
  "Params of the `generate-screen` workflow for a dialog submission
  (kebab-case here, camelCased on the wire). Optional values are left
  out when empty."
  [{:keys [prompt platform page-id reference-ids]}]
  (d/without-nils
   {:prompt (str/trim (or prompt ""))
    :platform (some-> platform name)
    :target-page-id (some-> page-id str)
    :reference-node-ids (when (seq reference-ids)
                          (mapv str reference-ids))}))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- result-message?
  [{:keys [type kind]}]
  (and (= "workflow.event" type) (= "result" kind)))

(defn show-result
  "Select the generated board and zoom to it when it is on the current
  page."
  [{:keys [board-id page-id]}]
  (ptk/reify ::show-result
    ptk/WatchEvent
    (watch [_ state _]
      (let [board-id (some-> board-id uuid/parse*)
            page-id  (some-> page-id uuid/parse*)]
        (if (and (some? board-id)
                 (= page-id (:current-page-id state))
                 (contains? (dsh/lookup-page-objects state page-id) board-id))
          (rx/of (dws/select-shapes (d/ordered-set board-id))
                 dwz/zoom-to-selected-shape)
          (rx/empty))))))

(defn generate-screen
  "Start the workflow for a dialog submission
  `{:prompt :platform :page-id :reference-ids}`, show its progress in
  the AI tab and select the board once it is there."
  [params]
  (ptk/reify ::generate-screen
    ptk/WatchEvent
    (watch [_ state stream]
      (let [rid (proto/next-rid)]
        (rx/merge
         ;; subscribed before the run starts, so no reply is missed
         (if (connected? state)
           (->> (chat/workflow-messages stream rid)
                (rx/filter result-message?)
                (rx/take 1)
                (rx/map (comp show-result :payload)))
           (rx/empty))
         (rx/of (chat/open-chat)
                (chat/run-workflow workflow-name
                                   (workflow-params params)
                                   {:rid rid})))))))

(defn dialog-props
  "Props of the dialog for the current state and selection."
  [state selected]
  {:platform (or (pf/current-platform state) :web)
   :selection (vec selected)
   :page (:current-page-id state)
   :submit #(st/emit! (generate-screen %))})

(defn- can-edit?
  [state]
  (and (not (get-in state [:workspace-global :read-only?]))
       (some? (:current-page-id state))))

(actions/register-action!
 {:id :ai/generate-screen
  :label #(tr "penforge.actions.generate-screen")
  :icon i/board
  :order 20
  :scopes #{:main-menu :command-palette}
  :enabled? can-edit?
  :run (fn [{:keys [state selected]}]
         (st/emit! (modal/show :penforge-generate-screen
                               (dialog-props state selected))))})
