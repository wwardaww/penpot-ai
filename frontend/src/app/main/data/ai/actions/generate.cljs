;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.generate
  "Generate a screen from a prompt (W13): the `:ai/generate-screen`
  action opens the prompt dialog, which starts the daemon workflow
  `generate-screen`. When the run reports its result the new board is
  selected and zoomed to.

  The daemon sends step codes with English fallback texts
  (architecture §7); the progress and the summary shown in the AI tab
  are translated here."
  (:require
   [app.common.data :as d]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.ask :as ask]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.helpers :as dsh]
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

(defn step-text
  "Translated text of a `progress` step code of the workflow, or nil
  for an unknown code (the daemon's English `text` stays then)."
  [step]
  (case step
    "design-system" (tr "penforge.generate.step.design-system")
    "board"         (tr "penforge.generate.step.board")
    "build"         (tr "penforge.generate.step.build")
    "check"         (tr "penforge.generate.step.check")
    "review"        (tr "penforge.generate.step.review")
    nil))

(defn summary-text
  "Translated summary of a run from its `result` payload."
  [{:keys [name width height inspection]}]
  (let [size      (str (js/Math.round (or width 0)) "×" (js/Math.round (or height 0)))
        instances (or (:instance-count inspection) 0)
        tokens    (count (:token-names inspection))]
    (if (or (pos? instances) (pos? tokens))
      (tr "penforge.generate.summary-details" name size instances tokens)
      (tr "penforge.generate.summary" name size))))

(defn localize-run
  "Replace the daemon's English texts of the run's chat entry: `attrs`
  holds the translated `:progress` and/or `:summary`. Applied after the
  chat stored the same daemon message."
  [run-id attrs]
  (ptk/reify ::localize-run
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :chat]
                 (fn [chat]
                   (if (contains? (:runs chat) run-id)
                     (-> chat
                         (update-in [:runs run-id] merge attrs)
                         (update :entries
                                 (fn [entries]
                                   (mapv (fn [entry]
                                           (if (and (= :workflow (:kind entry))
                                                    (= run-id (:id entry)))
                                             (merge entry attrs)
                                             entry))
                                         entries))))
                     chat))))))

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

(defn run-events
  "Events for one daemon message of the run: translated progress, the
  board selection on `result`, the translated summary on a successful
  `workflow.done`. `result*` keeps the result payload between messages."
  [result* {:keys [type kind run-id payload ok]}]
  (cond
    (and (= "workflow.event" type) (= "progress" kind))
    (if-let [text (step-text (:step payload))]
      [(localize-run run-id {:progress (assoc payload :text text)})]
      [])

    (and (= "workflow.event" type) (= "result" kind))
    (do (vreset! result* payload)
        [(show-result payload)])

    (and (= "workflow.done" type) ok (some? @result*))
    [(localize-run run-id {:summary (summary-text @result*)})]

    :else
    []))

(defn generate-screen
  "Start the workflow for a dialog submission
  `{:prompt :platform :page-id :reference-ids}`, show its progress in
  the AI tab (translated) and select the board once it is there."
  [params]
  (ptk/reify ::generate-screen
    ptk/WatchEvent
    (watch [_ state stream]
      (let [rid (proto/next-rid)]
        (rx/merge
         ;; subscribed before the run starts, so no reply is missed
         (if (connected? state)
           (let [result* (volatile! nil)]
             (->> (chat/workflow-messages stream rid)
                  (rx/mapcat #(rx/from (run-events result* %)))))
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
  ;; Screens are designed from the AI chat (the chat prompt knows how to
 ;; build one on the canvas); the action takes the user there. The
 ;; prompt dialog and its workflow stay available to other features.
 :run (fn [_]
        (st/emit! (ask/show-chat)))})
