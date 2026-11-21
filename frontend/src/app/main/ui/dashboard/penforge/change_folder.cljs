;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.change-folder
  "\"Change folder…\" of a Game UI or Existing project (dashboard project
  menu): pick another folder for the project, for example the right
  app of a monorepo after a wrong sub-folder was picked at creation.
  The daemon reads the new folder from scratch the next time a file of
  the project opens."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.linked :as linked]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.create-project :refer [folder-step* picked-folder]]
   [app.main.ui.dashboard.penforge.folder-browser.browser :refer [error-text]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ref:project-settings
  "Platform of each project of the team (`[:penforge-project-settings]`)."
  (l/derived :penforge-project-settings st/state))

(defn visible?
  "Whether the project menu offers \"Change folder…\" for `project`: a
  Game UI or Existing project (`settings` maps project ids to their
  platform), with the AI features on."
  [settings project]
  (and (pf/enabled?)
       (some? (:id project))
       (pf/linked-platform? (get settings (:id project)))))

(defn can-change?
  "True when `folder` (`{:path :facts}`) fits a project of `platform`
  and differs from the folder it is linked to now (`current-root`)."
  [platform folder current-root]
  (and (nil? (linked/folder-problem platform folder))
       (not= (:path folder) current-root)))

(defn open
  "Show the dialog for `project`."
  [project]
  (st/emit! (modal/show :penforge-change-folder {:project project})))

(def ^:private ref:linked
  (l/derived #(get-in % [:penforge :linked]) st/state =))

(def ^:private ref:connected
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(mf/defc change-folder-modal*
  {::mf/register modal/components
   ::mf/register-as :penforge-change-folder}
  [{:keys [project]}]
  (let [project-id   (:id project)
        platform     (mf/deref (mf/with-memo [project-id]
                                 (l/derived #(pf/get-project-platform % project-id) st/state)))
        linked-state (mf/deref ref:linked)
        connected    (mf/deref ref:connected)
        browser      (:browser linked-state)
        link         (:link linked-state)
        current-root (get-in linked-state [:projects (str project-id) :linked-root])
        folder       (picked-folder browser)
        submitted*   (mf/use-state false)
        submitted    (deref submitted*)
        failed       (and submitted (= :failed (:status link)))
        valid        (and (not (and submitted (not failed)))
                          (can-change? platform folder current-root))

        on-change
        (mf/use-fn
         (mf/deps project-id platform folder valid)
         (fn []
           (when valid
             (reset! submitted* true)
             (st/emit! (linked/link-project project-id platform (:path folder))))))

        on-submit
        (mf/use-fn
         (mf/deps on-change)
         (fn [event]
           (dom/prevent-default event)
           (on-change)))

        on-cancel
        (mf/use-fn #(st/emit! (modal/hide)))]

    (mf/with-effect []
      (st/emit! (linked/reset-link)))

    ;; the folder the project uses now, once the daemon client is up
    (mf/with-effect [connected project-id]
      (when connected
        (st/emit! (linked/fetch-link-status project-id))))

    (mf/with-effect [submitted link]
      (when (and submitted (= :linked (:status link)))
        (st/emit! (modal/hide)
                  (ntf/success (tr "penforge.change-folder.done")))))

    [:div {:class (stl/css :modal-overlay)}
     [:form {:class (stl/css :modal-container)
             :role "dialog"
             :aria-labelledby "penforge-change-folder-title"
             :data-testid "penforge-change-folder"
             :on-submit on-submit}

      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-change-folder-title"
                     :typography t/headline-medium
                     :class (stl/css :modal-title)}
        (tr "penforge.change-folder.title" (:name project))]
       [:> icon-button* {:variant "ghost"
                         :type "button"
                         :aria-label (tr "labels.close")
                         :icon i/close
                         :on-click on-cancel}]]

      [:div {:class (stl/css :modal-content)}
       [:> text* {:as "p"
                  :typography t/body-medium
                  :class (stl/css :current)}
        (if current-root
          (tr "penforge.change-folder.current" current-root)
          (tr "penforge.change-folder.current-unknown"))]

       (when (pf/linked-platform? platform)
         [:> folder-step* {:platform platform
                           :browser browser
                           :disabled (and submitted (not failed))}])

       (when (and folder (= (:path folder) current-root))
         [:p {:class (stl/css :hint)} (tr "penforge.change-folder.same")])

       (when failed
         [:p {:class (stl/css :error) :role "alert"} (error-text (:error link))])

       [:p {:class (stl/css :hint)} (tr "penforge.change-folder.reread")]]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary"
                    :type "button"
                    :on-click on-cancel}
        (tr "labels.cancel")]
       [:> button* {:variant "primary"
                    :type "submit"
                    :disabled (not valid)
                    :data-testid "penforge-change-folder-submit"}
        (tr "penforge.change-folder.submit")]]]]))
