;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.create-project
  "Penforge create-project panel: project name plus the project type as
  four selectable cards (Responsive Web, Mobile App, Game UI, Existing
  project). Game UI and Existing project also pick a folder of this
  computer through the daemon's folder browser (W38) and link it once
  the project exists. Replaces the instant auto named creation when the
  `:ai` flag is on."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.redesign :as rd]
   [app.main.data.ai.linked :as linked]
   [app.main.data.dashboard :as dd]
   [app.main.data.event :as ev]
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.folder-browser.browser :refer [folder-browser*
                                                                  error-text]]
   [app.main.ui.dashboard.penforge.option-cards :refer [option-cards*
                                                        web-illustration*
                                                        mobile-illustration*
                                                        game-illustration*
                                                        existing-illustration*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.chat.banner :refer [connection-banner*]]
   [app.main.ui.workspace.ai.design-system.binding.picker :refer [design-system-field*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def max-name-length 250)

(defn can-create?
  "True when the panel holds a usable name and a platform, plus, for
  Game UI and Existing projects, a `folder` (`{:path :facts}`) that
  fits the type."
  ([name platform]
   (can-create? name platform nil))
  ([name platform folder]
   (and (string? name)
        (not (str/blank? name))
        (<= (count (str/trim name)) max-name-length)
        (contains? pf/platforms platform)
        (or (not (pf/linked-platform? platform))
            (nil? (linked/folder-problem platform folder))))))

(defn picked-folder
  "The folder the browser shows, once the daemon answered for it."
  [{:keys [status path facts]}]
  (when (and (= :loaded status) (string? path))
    {:path path :facts facts}))

(def ^:private ref:linked
  (l/derived #(select-keys (get-in % [:penforge :linked]) [:browser :link]) st/state =))

(def ^:private ref:connection
  (l/derived #(get-in % [:penforge :connection]) st/state))

(mf/defc folder-step*
  "Folder step of Game UI and Existing projects; starts the daemon
  client while it shows. Also used by the \"Change folder\" dialog."
  [{:keys [platform browser disabled]}]
  (let [connection (mf/deref ref:connection)
        connected  (= :connected (:status connection))
        desktop    (some? (linked/desktop-bridge))

        on-open
        (mf/use-fn #(st/emit! (linked/list-folder %)))

        on-choose
        (mf/use-fn #(st/emit! (linked/choose-native-folder)))]

    (mf/with-effect []
      (st/emit! (linked/initialize-browser))
      (fn [] (st/emit! (linked/finalize-browser))))

    [:div {:class (stl/css :folder-step)}
     [:> text* {:as "span"
                :typography t/body-medium
                :class (stl/css :platform-label)}
      (if (= platform :game)
        (tr "penforge.create-project.folder.game")
        (tr "penforge.create-project.folder.existing"))]
     (if connected
       [:> folder-browser* {:browser browser
                            :platform platform
                            :desktop desktop
                            :disabled disabled
                            :on-open on-open
                            :on-choose on-choose}]
       [:> connection-banner* {:connection connection}])]))

(mf/defc create-project-modal*
  {::mf/register modal/components
   ::mf/register-as :penforge-create-project}
  []
  (let [name*       (mf/use-state "")
        name        (deref name*)
        platform*   (mf/use-state nil)
        platform    (deref platform*)
        submitted*  (mf/use-state false)
        submitted   (deref submitted*)
        linked      (mf/deref ref:linked)
        browser     (:browser linked)
        link        (:link linked)
        folder      (picked-folder browser)
        linked?     (pf/linked-platform? platform)
        link-failed (and submitted (= :failed (:status link)))
        ds*         (mf/use-state nil)
        ds          (deref ds*)
        valid       (and (not submitted) (can-create? name platform folder))

        options
        (mf/with-memo []
          [{:id :web
            :label (tr "penforge.create-project.platform.web")
            :caption (tr "penforge.create-project.platform.web-caption")
            :illustration (mf/html [:> web-illustration*])}
           {:id :mobile
            :label (tr "penforge.create-project.platform.mobile")
            :caption (tr "penforge.create-project.platform.mobile-caption")
            :illustration (mf/html [:> mobile-illustration*])}
           {:id :game
            :label (tr "penforge.create-project.platform.game")
            :caption (tr "penforge.create-project.platform.game-caption")
            :illustration (mf/html [:> game-illustration*])}
           {:id :existing
            :label (tr "penforge.create-project.platform.existing")
            :caption (tr "penforge.create-project.platform.existing-caption")
            :illustration (mf/html [:> existing-illustration*])}])

        on-name-change
        (mf/use-fn
         (fn [event]
           (reset! name* (dom/get-target-val event))))

        on-platform-change
        (mf/use-fn
         (mf/deps submitted)
         (fn [id]
           (when-not submitted
             (reset! platform* id))))

        create
        (mf/use-fn
         (mf/deps name platform valid linked? folder ds)
         (fn []
           (when valid
             (st/emit! (rd/remember-choice-for-new-project ds))
             (if linked?
               ;; the dialog stays open until the daemon linked the folder
               (let [path (:path folder)]
                 (reset! submitted* true)
                 (st/emit! (-> (dd/create-project
                                {:name (str/trim name)
                                 :platform platform
                                 :on-created (fn [project]
                                               (linked/link-project (:id project) platform path))})
                               (with-meta {::ev/origin "dashboard:penforge-create-project"}))))
               (st/emit! (-> (dd/create-project {:name (str/trim name)
                                                 :platform platform})
                             (with-meta {::ev/origin "dashboard:penforge-create-project"}))
                         (modal/hide))))))

        on-submit
        (mf/use-fn
         (mf/deps create)
         (fn [event]
           (dom/prevent-default event)
           (create)))

        on-cancel
        (mf/use-fn
         (fn [_] (st/emit! (modal/hide))))]

    (mf/with-effect []
      (st/emit! (linked/reset-link)))

    ;; close once the daemon linked the new project's folder
    (mf/with-effect [submitted link]
      (when (and submitted (= :linked (:status link)))
        (st/emit! (modal/hide))))

    [:div {:class (stl/css :modal-overlay)}
     [:form {:class (stl/css :modal-container)
             :role "dialog"
             :aria-labelledby "penforge-create-project-title"
             :data-testid "penforge-create-project"
             :on-submit on-submit}

      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-create-project-title"
                     :typography t/headline-medium
                     :class (stl/css :modal-title)}
        (tr "penforge.create-project.title")]
       [:> icon-button* {:variant "ghost"
                         :type "button"
                         :aria-label (tr "labels.close")
                         :icon i/close
                         :on-click on-cancel}]]

      [:div {:class (stl/css :modal-content)}
       [:> input* {:label (tr "penforge.create-project.name")
                   :placeholder (tr "penforge.create-project.name-placeholder")
                   :variant "comfortable"
                   :value name
                   :max-length max-name-length
                   :auto-focus true
                   :data-testid "penforge-create-project-name"
                   :on-change on-name-change}]

       [:div {:class (stl/css :platform)}
        [:> text* {:as "span"
                   :id "penforge-create-project-platform"
                   :typography t/body-medium
                   :class (stl/css :platform-label)}
         (tr "penforge.create-project.platform")]
        [:> option-cards* {:options options
                           :value platform
                           :columns 2
                           :label (tr "penforge.create-project.platform")
                           :on-change on-platform-change
                           :on-submit create}]]

       (when linked?
         [:> folder-step* {:platform platform
                           :browser browser
                           :disabled submitted}])

       (cond
         link-failed
         [:div {:class (stl/css :link-status :link-status-error) :role "alert"}
          [:p {:class (stl/css :link-text)} (error-text (:error link))]
          [:p {:class (stl/css :link-text)} (tr "penforge.create-project.link-failed")]]

         submitted
         [:p {:class (stl/css :link-status)} (tr "penforge.create-project.linking")]

         :else
         nil)

       [:> design-system-field* {:team-id (:current-team-id @st/state)
                                 :on-change #(reset! ds* %)}]]

      [:div {:class (stl/css :modal-footer)}
       (if link-failed
         [:> button* {:variant "primary"
                      :type "button"
                      :on-click on-cancel}
          (tr "labels.close")]
         [:*
          [:> button* {:variant "secondary"
                       :type "button"
                       :disabled submitted
                       :on-click on-cancel}
           (tr "labels.cancel")]
          [:> button* {:variant "primary"
                       :type "submit"
                       :disabled (not valid)
                       :data-testid "penforge-create-project-submit"}
           (tr "penforge.create-project.create")]])]]]))
