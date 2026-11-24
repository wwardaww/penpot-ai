;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.output-dialog
  "Folder dialog of Build and Instruct (W41), with W38's folder browser,
  and the folder line the Build and Instruct dialogs show.

  `picker-view*` and `folder-line*` render from plain props (tests
  render them)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.linked :as linked]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.folder-browser.browser :as browser :refer [folder-browser*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.build.output :as output]
   [app.main.ui.workspace.ai.chat.banner :refer [connection-banner*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:picker
  (l/derived #(get-in % [:penforge :output :picker]) st/state =))

(def ^:private ref:browser
  (l/derived #(get-in % [:penforge :linked :browser]) st/state =))

(def ^:private ref:connection
  (l/derived #(get-in % [:penforge :connection]) st/state))

(defn error-text
  "Translated text of a refused output folder."
  [{:keys [reason] :as error}]
  (case reason
    "folder-refused" (tr "penforge.output.error.folder-refused")
    "folder-taken"   (tr "penforge.output.error.folder-taken")
    "inside-git"     (tr "penforge.output.error.inside-git")
    "not-writable"   (tr "penforge.output.error.not-writable")
    "build-running"  (tr "penforge.output.error.build-running")
    (browser/error-text error)))

(mf/defc folder-line*
  "The folder a run writes to, with a link to change it (when
  `on-change` is given)."
  [{:keys [purpose path on-change]}]
  (when (string? path)
    [:div {:class (stl/css :folder-line)
           :data-testid "penforge-output-line"}
     [:> text* {:as "span" :typography t/body-small :class (stl/css :folder-label)}
      (if (= purpose :instruct)
        (tr "penforge.output.line.instruct")
        (tr "penforge.output.line.build"))]
     [:span {:class (stl/css :folder-path) :title path} path]
     (when (fn? on-change)
       [:button {:type "button"
                 :class (stl/css :folder-change)
                 :on-click on-change}
        (tr "penforge.output.change")])]))

(mf/defc output-line*
  "`folder-line*` of the open project."
  [{:keys [purpose on-change]}]
  (let [project-id (mf/deref (mf/with-memo [] (l/derived :current-project-id st/state)))
        folder     (mf/deref (mf/with-memo [project-id]
                               (l/derived #(output/get-output % project-id) st/state =)))]
    (mf/with-effect [project-id]
      (st/emit! (output/fetch-output project-id)))
    [:> folder-line* {:purpose purpose
                      :path (output/get-path purpose folder)
                      :on-change on-change}]))

(mf/defc picker-view*
  "Props: `purpose`, `folder` (what the daemon knows about the project's
  output folder), `browser` and `picker` states, `desktop`, callbacks
  `on-open`, `on-choose`, `on-confirm`, `on-cancel`."
  [{:keys [purpose folder browser picker desktop on-open on-choose on-confirm on-cancel]}]
  (let [path    (when (= :loaded (:status browser)) (:path browser))
        target  (:target picker)
        saving  (= :saving (:status picker))
        usable  (output/can-use? picker path)
        missing (and (= "missing" (get-in folder [:app :state])) (= purpose :build))
        moves   (and (= purpose :build)
                     (contains? #{"internal" "ready"} (get-in folder [:app :state]))
                     (some? target)
                     (not= (:path target) (get-in folder [:app :path])))]
    [:*
     [:div {:class (stl/css :content)}
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :intro)}
       (cond
         missing                (tr "penforge.output.missing" (get-in folder [:app :path]))
         (= purpose :instruct)  (tr "penforge.output.intro.instruct")
         :else                  (tr "penforge.output.intro.build"))]

      [:> folder-browser* {:browser browser
                           :platform :web
                           :desktop desktop
                           :disabled saving
                           :on-open on-open
                           :on-choose on-choose}]

      (when (and usable (some? target))
        [:div {:class (stl/css :target)
               :data-testid "penforge-output-target"}
         [:p {:class (stl/css :target-text)}
          (if (= purpose :instruct)
            (tr "penforge.output.target.instruct" (:path target))
            (tr "penforge.output.target.build" (:path target)))]
         [:p {:class (stl/css :hint)}
          (cond
            (:existing target)   (tr "penforge.output.target.existing")
            (:sub-folder target) (tr "penforge.output.target.sub-folder")
            :else                (tr "penforge.output.target.empty"))]
         (when moves
           [:p {:class (stl/css :hint :warning)}
            (tr "penforge.output.target.moves" (get-in folder [:app :path]))])])

      (when (= :failed (:status picker))
        [:p {:class (stl/css :error) :role "alert"}
         (error-text (:error picker))])]

     [:div {:class (stl/css :footer)}
      [:> button* {:variant "secondary"
                   :type "button"
                   :on-click on-cancel}
       (tr "labels.cancel")]
      [:> button* {:variant "primary"
                   :type "button"
                   :disabled (not usable)
                   :data-testid "penforge-output-confirm"
                   :on-click on-confirm}
       (tr "penforge.output.confirm")]]]))

(mf/defc output-folder-modal
  "Modal `:penforge-output-folder`. Props: `:project-id`,
  `:project-name`, `:purpose` (`:build` / `:instruct`, by default what
  the project needs), `:dashboard` true outside a workspace, and the
  optional fns `:on-done` and `:on-cancel` answering the next event."
  {::mf/register modal/components
   ::mf/register-as output/modal-type}
  [{:keys [project-id project-name purpose dashboard on-done on-cancel]}]
  (let [picker     (mf/deref ref:picker)
        browser    (mf/deref ref:browser)
        connection (mf/deref ref:connection)
        folder     (mf/deref (mf/with-memo [project-id]
                               (l/derived #(output/get-output % project-id) st/state =)))
        connected  (= :connected (:status connection))
        purpose    (or purpose (output/get-purpose folder))
        path       (when (= :loaded (:status browser)) (:path browser))
        props      {:project-id project-id
                    :project-name project-name
                    :purpose purpose
                    :on-done on-done
                    :on-cancel on-cancel}

        on-open    (mf/use-fn #(st/emit! (linked/list-folder %)))
        on-choose  (mf/use-fn #(st/emit! (linked/choose-native-folder)))
        on-confirm (mf/use-fn
                    (mf/deps path purpose project-id)
                    #(st/emit! (output/set-folder props path)))
        on-close   (mf/use-fn
                    (mf/deps on-cancel)
                    #(st/emit! (output/cancel-picker props)))]

    (mf/with-effect []
      (st/emit! (output/reset-picker)
                (linked/reset-link))
      (if dashboard
        ;; the dashboard has no daemon client of its own
        (st/emit! (linked/initialize-browser))
        (st/emit! (linked/list-folder (output/get-start-path folder))))
      (fn []
        (st/emit! (output/reset-picker))
        (when dashboard
          (st/emit! (linked/finalize-browser)))))

    (mf/with-effect [connected project-id]
      (when connected
        (st/emit! (output/fetch-output project-id))))

    (mf/with-effect [path purpose project-id]
      (when (string? path)
        (st/emit! (output/check-folder props path))))

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "penforge-output-title"
            :data-testid "penforge-output-dialog"}
      [:div {:class (stl/css :header)}
       [:> heading* {:level 2
                     :id "penforge-output-title"
                     :typography t/headline-medium
                     :class (stl/css :title)}
        (if (= purpose :instruct)
          (tr "penforge.output.title.instruct")
          (tr "penforge.output.title.build"))]
       [:> icon-button* {:variant "ghost"
                         :aria-label (tr "labels.close")
                         :icon i/close
                         :on-click on-close}]]
      (if connected
        [:> picker-view* {:purpose purpose
                          :folder folder
                          :browser browser
                          :picker picker
                          :desktop (some? (linked/desktop-bridge))
                          :on-open on-open
                          :on-choose on-choose
                          :on-confirm on-confirm
                          :on-cancel on-close}]
        [:> connection-banner* {:connection connection}])]]))
