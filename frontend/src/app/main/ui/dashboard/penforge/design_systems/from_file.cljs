;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.design-systems.from-file
  "\"Create design system from this file\" (W36): asks for the design
  system's name (default \"<project name> Design System\") and, opened
  from a project menu, which file of the project to start from. The
  file is copied; the original stays as it is."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.config :as cf]
   [app.main.data.ai.actions.design-system-extract :as dsx]
   [app.main.data.ai.design-system :as ds]
   [app.main.data.modal :as modal]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn source-files
  "Files a design system can start from (not deleted), by name."
  [files]
  (->> files
       (remove :deleted-at)
       (sort-by #(str/lower (str (:name %))))
       (vec)))

;; --- Dashboard menu entries (one line each in the upstream menus)

(defn- project-of
  [file projects]
  (some #(when (= (:id %) (:project-id file)) %) projects))

(defn- project-label
  "Name used for the default design system name; drafts have none."
  [project]
  (when-not (:is-default project) (:name project)))

(defn file-entry-visible?
  "File card menu: a file outside the design systems project, `:ai` on."
  [file projects]
  (and (contains? cf/flags :ai)
       (dsx/source-file? file (project-of file projects))))

(defn open-for-file
  "Opens the dialog for one dashboard file."
  [file projects team-id]
  (st/emit! (dsx/open-dialog {:file (select-keys file [:id :name :project-id :revn])
                              :project-name (project-label (project-of file projects))
                              :team-id team-id})))

(defn project-entry-visible?
  "Project menu: a project with several files, not the design systems
  one, `:ai` on."
  [project]
  (and (contains? cf/flags :ai)
       (not (:is-default project))
       (not= ds/project-name (:name project))
       (> (or (:count project) 0) 1)))

(defn open-for-project
  "Opens the dialog with the project's files to pick from."
  [project]
  (st/emit! (dsx/open-dialog {:project-id (:id project)
                              :project-name (project-label project)
                              :team-id (:team-id project)})))

(mf/defc file-choice*
  {::mf/private true}
  [{:keys [files selected on-select]}]
  [:fieldset {:class (stl/css :files)}
   [:legend {:class (stl/css :label)} (tr "penforge.design-system-extract.dialog.pick-file")]
   (for [{:keys [id name]} files]
     (let [input-id (dm/str "penforge-dsx-file-" id)]
       [:label {:key (dm/str id) :for input-id :class (stl/css :file-row)}
        [:input {:type "radio"
                 :id input-id
                 :name "penforge-dsx-file"
                 :checked (= id selected)
                 :on-change #(on-select id)}]
        [:span {:class (stl/css :file-name)} name]]))])

(mf/defc from-file-form*
  "The dialog body from plain props (rendered by tests too). `files` are
  the choices (nil while loading); `file` the preselected one."
  [{:keys [file files project-name on-submit on-cancel]}]
  (let [selected*   (mf/use-state (:id file))
        selected-id (deref selected*)
        choices     (or files (when file [file]))
        current     (or (some #(when (= selected-id (:id %)) %) choices) file)
        suggested   (dsx/default-name project-name (:name current))
        name*       (mf/use-state nil)
        typed       (deref name*)
        value       (or typed suggested)
        ready?      (and (some? current) (not (str/blank? value)))

        on-name
        (mf/use-fn #(reset! name* (dom/get-target-val %)))

        submit
        (mf/use-fn
         (mf/deps current value on-submit ready?)
         (fn [event]
           (dom/prevent-default event)
           (when ready?
             (on-submit current (str/trim value)))))]

    [:form {:class (stl/css :form) :on-submit submit}
     [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
      (tr "penforge.design-system-extract.dialog.hint")]
     [:> input* {:id "penforge-dsx-name"
                 :label (tr "penforge.design-system-extract.dialog.name")
                 :value value
                 :max-length 250
                 :auto-focus true
                 :on-change on-name}]
     (cond
       (and (nil? files) (nil? file))
       [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)} (tr "labels.loading")]

       (and (some? files) (empty? files))
       [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
        (tr "penforge.design-system-extract.dialog.no-files")]

       (> (count choices) 1)
       [:> file-choice* {:files choices
                         :selected (:id current)
                         :on-select #(reset! selected* %)}])
     [:div {:class (stl/css :footer)}
      [:> button* {:variant "secondary" :type "button" :on-click on-cancel}
       (tr "labels.cancel")]
      [:> button* {:variant "primary" :type "submit" :disabled (not ready?)}
       (tr "penforge.design-system-extract.dialog.create")]]]))

(mf/defc from-file-dialog
  "Modal `:penforge-design-system-from-file`. Props: `:file` `{:id :name
  :project-id :revn}`, or `:project-id` (the project's files are
  listed), `:project-name`, `:team-id`."
  {::mf/register modal/components
   ::mf/register-as :penforge-design-system-from-file}
  [{:keys [file project-id project-name team-id]}]
  (let [files* (mf/use-state nil)
        files  (deref files*)

        on-cancel
        (mf/use-fn #(modal/hide!))

        on-submit
        (mf/use-fn
         (mf/deps team-id)
         (fn [{:keys [id project-id revn]} name]
           (modal/hide!)
           (st/emit! (dsx/create-from-file {:team-id team-id
                                            :file-id id
                                            :project-id project-id
                                            :revn revn
                                            :name name}))))]

    (mf/with-effect [file project-id]
      (when (and (nil? file) (some? project-id))
        (let [subscription (->> (rp/cmd! :get-project-files {:project-id project-id})
                                (rx/subs! #(reset! files* (source-files %))
                                          (fn [_] (reset! files* []))))]
          #(rx/dispose! subscription))))

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-dsx-title"}
      [:> icon-button* {:variant "ghost"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click on-cancel}]
      [:div {:class (stl/css :modal-title) :id "penforge-dsx-title"}
       (tr "penforge.design-system-extract.dialog.title")]
      [:> from-file-form* {:file file
                           :files files
                           :project-name project-name
                           :on-submit on-submit
                           :on-cancel on-cancel}]]]))
