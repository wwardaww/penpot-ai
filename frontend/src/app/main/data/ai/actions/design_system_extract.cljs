;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.design-system-extract
  "Design system from an existing project (W36).

  \"Create design system from this file\" (dashboard file and project
  menus, workspace AI menu) asks for a name, then copies the file with
  Penpot's `duplicate-file` (the source is never changed; ids of pages,
  shapes, components, colors and typographies stay the same in the
  copy), moves the copy into the team project \"Design Systems\" and
  marks it `penforge/designSystem` with `source {fileId, projectId,
  revn}`. The copy opens in design-system mode, where the daemon
  workflow `design-system-extract` lists ONE set of proposals (a
  checkbox each, on by default) and applies the checked ones."
  (:require
   [app.common.data :as d]
   [app.common.data.macros :as dm]
   [app.common.logging :as log]
   [app.config :as cf]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.design-system :as ds]
   [app.main.data.common :as dcm]
   [app.main.data.helpers :as dsh]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.data.workspace.libraries :as dwl]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

;; --- Constants

(def workflow "design-system-extract")

(def state-path [:penforge :design-system-extract])

(def dialog-key
  "Modal of the name (and file) question."
  :penforge-design-system-from-file)

(def sections
  "Sections of the proposal list, in display order."
  [:colors :text :tokens :components :icons :cleanup])

;; --- Pure helpers

(defn default-name
  "Default design system name: \"<project name> Design System\"."
  [project-name file-name]
  (tr "penforge.design-system-extract.default-name"
      (or (when-not (str/blank? project-name) project-name)
          file-name
          "")))

(defn marker-json
  "JSON of the marker of a new copy, with its source."
  [name created-at {:keys [file-id project-id revn]}]
  (js/JSON.stringify
   (clj->js {:version 1
             :name name
             :createdAt created-at
             :source {:fileId (dm/str file-id)
                      :projectId (dm/str project-id)
                      :revn (or revn 0)}})))

(defn extract-pending?
  "Whether a design system marker belongs to a copy whose proposals
  were not applied yet."
  [marker]
  (boolean (and (map? (:source marker))
                (some? (get-in marker [:source :file-id]))
                (nil? (:extracted-at marker)))))

(defn source-file?
  "Whether a dashboard file can be the source: not a design system
  itself (not in the design systems project) and not deleted."
  [file project]
  (and (some? file)
       (nil? (:deleted-at file))
       (not= ds/project-name (:name project))))

(defn proposal-section
  "Section of the list a proposal goes in."
  [{:keys [kind]}]
  (case kind
    ("merge-colors" "color-token") :colors
    "text-style" :text
    "token" :tokens
    ("component" "rename-component" "group-components") :components
    "icons" :icons
    "drop-unused" :cleanup
    :cleanup))

(defn grouped-proposals
  "Proposals by section, sections in display order, empty ones left out."
  [proposals]
  (let [by-section (group-by proposal-section proposals)]
    (into []
          (comp (map (fn [section] [section (get by-section section)]))
                (filter (comp seq second)))
          sections)))

(defn- join-names
  [names]
  (str/join ", " (map str names)))

(defn proposal-text
  "Translated text of a proposal (its `code` and `params`), falling back
  to the daemon's English text."
  [{:keys [code params text]}]
  (let [{:keys [hex token count library colors keep name font-family
                font-size font-weight screens variants from to path
                names value blur drawn]} params]
    (case code
      "color-token"         (tr "penforge.design-system-extract.proposal.color-token" hex count token)
      "color-token-library" (tr "penforge.design-system-extract.proposal.color-token-library" library hex token)
      "merge-colors"        (tr "penforge.design-system-extract.proposal.merge-colors" count (join-names colors) token keep)
      "text-style"          (tr "penforge.design-system-extract.proposal.text-style" font-family font-size font-weight count name)
      "spacing-token"       (tr "penforge.design-system-extract.proposal.spacing-token" value count token)
      "radius-token"        (tr "penforge.design-system-extract.proposal.radius-token" value count token)
      "shadow-token"        (tr "penforge.design-system-extract.proposal.shadow-token" blur count token)
      "component"           (tr "penforge.design-system-extract.proposal.component" name count screens)
      "component-variants"  (tr "penforge.design-system-extract.proposal.component-variants" name count screens variants)
      "rename-component"    (tr "penforge.design-system-extract.proposal.rename-component" from to)
      "group-components"    (tr "penforge.design-system-extract.proposal.group-components" count (join-names names) path)
      "icons"               (tr "penforge.design-system-extract.proposal.icons" (or count drawn))
      "unused-color"        (tr "penforge.design-system-extract.proposal.unused-color" name)
      "unused-typography"   (tr "penforge.design-system-extract.proposal.unused-typography" name)
      "unused-component"    (tr "penforge.design-system-extract.proposal.unused-component" name)
      (or text code))))

(defn section-title
  [section]
  (case section
    :colors     (tr "penforge.design-system-extract.section.colors")
    :text       (tr "penforge.design-system-extract.section.text")
    :tokens     (tr "penforge.design-system-extract.section.tokens")
    :components (tr "penforge.design-system-extract.section.components")
    :icons      (tr "penforge.design-system-extract.section.icons")
    :cleanup    (tr "penforge.design-system-extract.section.cleanup")))

(defn skip-ids
  "Ids of the proposals the user unchecked."
  [proposals checked]
  (into [] (comp (map :id) (remove #(contains? checked %))) proposals))

(defn error-text
  "Translated text of a failure code."
  [code]
  (case code
    "not-a-copy"   (tr "penforge.design-system-extract.error.not-a-copy")
    "plan-changed" (tr "penforge.design-system-extract.error.plan-changed")
    "cancelled"    (tr "penforge.design-system-extract.error.cancelled")
    "not-connected" (tr "penforge.design-system-extract.error.not-connected")
    (tr "penforge.design-system-extract.error.generic")))

(defn- with-plan
  [state plan]
  (assoc state
         :plan (select-keys plan [:plan-id :stats :proposals :name :source])
         :checked (into #{} (map :id) (:proposals plan))))

(defn next-state
  "Extraction state after a daemon message of the running plan or apply
  run (see `app.main.data.ai.chat/workflow-messages`)."
  [state {:keys [type kind payload ok code error message]}]
  (cond
    (and (= type "workflow.event") (= kind "plan"))
    (-> (with-plan state payload)
        (assoc :status (if (= :applying (:status state)) :applying :ready)))

    (and (= type "workflow.event") (= kind "progress"))
    (assoc state :progress (:text payload))

    (and (= type "workflow.event") (= kind "failed"))
    (assoc state :error (:code payload))

    (and (= type "workflow.event") (= kind "result") (= "apply" (:mode payload)))
    (assoc state :result payload)

    (= type "workflow.done")
    (cond
      ok
      (-> state
          (assoc :status (if (= :applying (:status state)) :done :ready))
          (dissoc :rid :progress))

      ;; the file changed: the new list is shown, the old one is gone
      (= "plan-changed" (:error state))
      (-> state (assoc :status :ready :notice "plan-changed") (dissoc :rid :progress :error))

      :else
      (-> state
          (assoc :status :error :error (or (:error state) error "internal"))
          (dissoc :rid :progress)))

    (= type "error")
    (-> state
        (assoc :status :error :error (or code message "internal"))
        (dissoc :rid :progress))

    :else
    state))

;; --- State

(defn current
  "Extraction state of the open file, or an idle one."
  [state]
  (let [entry (get-in state state-path)]
    (if (= (:file-id entry) (:current-file-id state))
      entry
      {:status :idle})))

(defn- update-current
  [state f & args]
  (let [file-id (:current-file-id state)]
    (assoc-in state state-path (apply f (assoc (current state) :file-id file-id) args))))

(defn toggle-proposal
  [id]
  (ptk/reify ::toggle-proposal
    ptk/UpdateEvent
    (update [_ state]
      (update-current state update :checked
                      #(if (contains? % id) (disj % id) (conj (or % #{}) id))))))

(defn set-all
  "Checks (`true`) or unchecks every proposal."
  [checked?]
  (ptk/reify ::set-all
    ptk/UpdateEvent
    (update [_ state]
      (update-current state
                      (fn [entry]
                        (assoc entry :checked
                               (if checked?
                                 (into #{} (map :id) (get-in entry [:plan :proposals]))
                                 #{})))))))

(defn- folded
  "Folds one run message into the state of `file-id` (left alone when
  another file is open by now)."
  [file-id message]
  (ptk/reify ::folded
    ptk/UpdateEvent
    (update [_ state]
      (if (= file-id (get-in state (conj state-path :file-id)))
        (update-in state state-path next-state message)
        state))))

(defn- follow
  "Starts the workflow and folds its messages into the state; an apply
  result with `publish` true publishes the file as a shared library."
  [rid params opts]
  (ptk/reify ::follow
    ptk/WatchEvent
    (watch [_ state stream]
      (let [file-id (:current-file-id state)
            shared  (ds/shared? state)]
        (rx/merge
         (->> (chat/workflow-messages stream rid)
              (rx/mapcat
               (fn [message]
                 (let [result (when (and (= "workflow.event" (:type message))
                                         (= "result" (:kind message)))
                                (:payload message))]
                   (rx/concat
                    (rx/of (folded file-id message))
                    (if (and (= "apply" (:mode result))
                             (true? (:publish result))
                             (uuid? file-id)
                             (not shared))
                      (rx/of (dwl/set-file-shared file-id true))
                      (rx/empty))))))
              (rx/catch (fn [cause]
                          (log/warn :hint "design system extraction failed" :cause cause)
                          (rx/of (folded file-id {:type "error" :code "internal"})))))
         ;; subscribed above before the request goes out
         (rx/of (chat/run-workflow workflow params (assoc opts :rid rid))))))))

(defn request-plan
  "Reads the copy and asks the daemon for the proposal list (silent:
  the list shows in the extraction card)."
  []
  (ptk/reify ::request-plan
    ptk/UpdateEvent
    (update [_ state]
      (assoc-in state state-path {:file-id (:current-file-id state)
                                  :status :planning}))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (follow (str (random-uuid)) {:mode "plan"} {:silent true})))))

(defn apply-plan
  "Applies the checked proposals (the run shows in the chat: progress
  and the publish question)."
  []
  (ptk/reify ::apply-plan
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [plan checked status]} (current state)]
        (if (and (= :ready status) (some? plan))
          (let [rid    (str (random-uuid))
                params (d/without-nils
                        {:mode "apply"
                         :plan-id (:plan-id plan)
                         :skip (skip-ids (:proposals plan) (or checked #{}))
                         :shared (when (ds/shared? state) true)})]
            (rx/of (ptk/reify ::applying
                     ptk/UpdateEvent
                     (update [_ state]
                       (update-current state #(-> % (assoc :status :applying)
                                                  (dissoc :notice :error)))))
                   (chat/open-chat)
                   (follow rid params {})))
          (rx/empty))))))

(defn maybe-request-plan
  "Starts the proposal list once for a pending copy (editors only,
  connected, nothing listed or running yet)."
  []
  (ptk/reify ::maybe-request-plan
    ptk/WatchEvent
    (watch [_ state _]
      (if (and (extract-pending? (ds/current-marker state))
               (ds/can-edit? state)
               (= :connected (get-in state [:penforge :connection :status]))
               (= :idle (:status (current state))))
        (rx/of (request-plan))
        (rx/empty)))))

;; --- Copy (dashboard and workspace)

(defn- ensure-project
  [state team-id]
  (if-let [project (ds/design-systems-project (dsh/lookup-team-projects state team-id))]
    (rx/of project)
    (rp/cmd! :create-project {:team-id team-id :name ds/project-name})))

(defn- mark-copy
  [state {:keys [id revn vern features] :as file} name source]
  (->> (rp/cmd! :update-file
                (cond-> {:id id
                         :session-id (or (:session-id state) cf/session-id)
                         :revn (or revn 0)
                         :vern (or vern 0)
                         :changes [{:type :set-plugin-data
                                    :object-type :file
                                    :namespace ds/plugin-namespace
                                    :key ds/marker-key
                                    :value (marker-json name (.toISOString (js/Date.)) source)}]}
                  (some? features)
                  (assoc :features features)))
       (rx/map (constantly file))))

(defn create-from-file
  "Copies `file-id` into the design systems project under `name`, marks
  the copy with its source and opens it. The source is not changed."
  [{:keys [team-id file-id project-id revn name]}]
  (ptk/reify ::create-from-file
    ptk/WatchEvent
    (watch [_ state _]
      (let [team-id (or team-id (:current-team-id state))
            name    (str/trim (str name))
            source  {:file-id file-id :project-id project-id :revn revn}]
        (->> (ensure-project state team-id)
             (rx/mapcat
              (fn [project]
                (->> (rp/cmd! :duplicate-file {:file-id file-id :name name})
                     (rx/mapcat
                      (fn [copy]
                        (->> (rp/cmd! :move-files {:ids #{(:id copy)} :project-id (:id project)})
                             (rx/map (constantly copy)))))
                     (rx/mapcat #(mark-copy state % name source))
                     (rx/map (fn [copy]
                               (dcm/go-to-workspace :team-id team-id :file-id (:id copy)))))))
             (rx/catch (fn [cause]
                         (log/error :hint "unable to copy the file into a design system" :cause cause)
                         (rx/of (ntf/error (tr "penforge.design-system-extract.copy-failed"))))))))))

(defn open-dialog
  "Asks for the design system's name (and, from a project menu, which
  file). Props: `:file` `{:id :name :project-id :revn}` or `:files`,
  plus `:project-name`, `:team-id`."
  [props]
  (modal/show dialog-key props))

;; --- Workspace action

(defn- source-props
  [state]
  (let [file       (dsh/lookup-file state)
        project-id (:project-id file)
        project    (get-in state [:projects project-id])]
    {:file {:id (:id file)
            :name (:name file)
            :project-id project-id
            :revn (:revn file)}
     :project-name (:name project)
     :team-id (:current-team-id state)}))

(defn action-visible?
  "Shown to editors of a normal file while nothing runs."
  [state]
  (and (contains? cf/flags :ai)
       (some? (:current-file-id state))
       (ds/can-edit? state)
       (not (ds/design-system-file? state))
       (not (chat/busy? (get-in state [:penforge :chat])))))

(actions/register-action!
 {:id :ai/design-system-from-file
  :label #(tr "penforge.design-system-extract.action")
  :icon i/library
  :order 40
  :scopes #{:main-menu :command-palette}
  :visible? action-visible?
  :run (fn [{:keys [state]}]
         (st/emit! (open-dialog (source-props (or state @st/state)))))})
