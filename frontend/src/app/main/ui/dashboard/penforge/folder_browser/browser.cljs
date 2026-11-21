;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.folder-browser.browser
  "Folder picker of Game UI and Existing projects (W38). The browser
  cannot give a folder's real path, so the Penforge daemon lists the
  folders of this computer (`folder.list`): drives and the home folder
  first, then sub-folders, with a path field to paste into. The folder
  shown is the one picked. In the desktop app the native folder dialog
  replaces the list.

  `folder-browser*` renders from plain props (tests render it too); the
  data lives in `app.main.data.ai.linked`."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.linked :as linked]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def max-markers
  "Project markers (package.json, pubspec.yaml...) shown as badges."
  4)

(defn error-text
  "Translated text of a refused `folder.list` / `project.link`."
  [{:keys [code reason]}]
  (cond
    (= code "not-connected")  (tr "penforge.folder-browser.error.not-connected")
    (= code "not-configured") (tr "penforge.folder-browser.error.not-configured")
    :else
    (case reason
      "bad-path"          (tr "penforge.folder-browser.error.bad-path")
      "folder-missing"    (tr "penforge.folder-browser.error.folder-missing")
      "not-a-folder"      (tr "penforge.folder-browser.error.not-a-folder")
      "folder-unreadable" (tr "penforge.folder-browser.error.folder-unreadable")
      "folder-refused"    (tr "penforge.folder-browser.error.folder-refused")
      "not-a-game"        (tr "penforge.folder-browser.problem.not-a-game")
      "empty-folder"      (tr "penforge.folder-browser.problem.empty-folder")
      (tr "penforge.folder-browser.error.generic"))))

(defn problem-text
  "Translated text of a `linked/folder-problem`, or nil."
  [problem]
  (case problem
    :not-a-game   (tr "penforge.folder-browser.problem.not-a-game")
    :empty-folder (tr "penforge.folder-browser.problem.empty-folder")
    :no-folder    (tr "penforge.folder-browser.problem.no-folder")
    nil))

(defn fact-badges
  "Badge texts for the facts of a folder: engine, git, stack markers."
  [facts]
  (when (map? facts)
    (into (cond-> []
            (= "unity" (:engine facts))  (conj (tr "penforge.folder-browser.fact.unity"))
            (= "unreal" (:engine facts)) (conj (tr "penforge.folder-browser.fact.unreal"))
            (true? (:git facts))         (conj (tr "penforge.folder-browser.fact.git")))
          (comp (filter string?) (take max-markers))
          (:markers facts))))

(mf/defc folder-row*
  {::mf/private true}
  [{:keys [entry icon on-open]}]
  (let [on-click
        (mf/use-fn
         (mf/deps entry on-open)
         (fn [_] (on-open (:path entry))))]
    [:li {:class (stl/css :row)}
     [:button {:type "button"
               :class (stl/css :row-button)
               :title (:path entry)
               :on-click on-click}
      [:> icon* {:icon-id icon :size "s" :class (stl/css :row-icon)}]
      [:span {:class (stl/css :row-name)} (:name entry)]]]))

(mf/defc folder-browser*
  "Props: `browser` the `[:penforge :linked :browser]` state, `platform`
  of the project (`:game` / `:existing`, for the problem line),
  `desktop` true in the desktop app, `disabled`, `on-open` fn of a path
  (nil = drives), `on-choose` fn opening the native dialog."
  [{:keys [browser platform desktop disabled on-open on-choose]}]
  (let [{:keys [status path parent roots entries truncated facts error requested]} browser
        loaded   (= :loaded status)
        loading  (= :loading status)
        input*   (mf/use-state (or path requested ""))
        input    (deref input*)
        problem  (when loaded
                   (linked/folder-problem platform {:path path :facts facts}))
        badges   (when loaded (fact-badges facts))
        items    (if (and loaded (nil? path)) roots entries)

        on-input
        (mf/use-fn #(reset! input* (dom/get-target-val %)))

        go
        (mf/use-fn
         (mf/deps input on-open)
         (fn []
           (when-not (str/blank? input)
             (on-open (str/trim input)))))

        on-key-down
        (mf/use-fn
         (mf/deps go)
         (fn [event]
           (when (kbd/enter? event)
             ;; the field sits inside the create-project form
             (dom/prevent-default event)
             (go))))

        on-up
        (mf/use-fn
         (mf/deps parent on-open)
         (fn [_] (on-open parent)))]

    ;; show the folder the daemon answered (it may differ from the typed one)
    (mf/with-effect [path]
      (when (string? path)
        (reset! input* path)))

    [:section {:class (stl/css :browser)
               :aria-busy loading
               :data-testid "penforge-folder-browser"}
     (if desktop
       [:div {:class (stl/css :desktop-row)}
        [:> button* {:variant "secondary"
                     :type "button"
                     :disabled disabled
                     :on-click on-choose}
         (tr "penforge.folder-browser.choose")]
        [:span {:class (stl/css :current-path)
                :title (or path "")}
         (if (and loaded (string? path))
           path
           (tr "penforge.folder-browser.none"))]]

       [:*
        [:div {:class (stl/css :path-row)}
         ;; a plain button: the DS icon button's tooltip needs a DOM portal
         [:button {:type "button"
                   :class (stl/css :up-button)
                   :disabled (or disabled (not loaded) (nil? path))
                   :title (tr "penforge.folder-browser.up")
                   :aria-label (tr "penforge.folder-browser.up")
                   :on-click on-up}
          [:> icon* {:icon-id i/arrow-up :size "s"}]]
         [:input {:type "text"
                  :class (stl/css :path-input)
                  :value input
                  :disabled disabled
                  :spell-check false
                  :aria-label (tr "penforge.folder-browser.path")
                  :placeholder (tr "penforge.folder-browser.path-placeholder")
                  :on-change on-input
                  :on-key-down on-key-down}]
         [:> button* {:variant "secondary"
                      :type "button"
                      :disabled (or disabled (str/blank? input))
                      :on-click go}
          (tr "penforge.folder-browser.go")]]

        [:div {:class (stl/css :list-wrapper)}
         (cond
           loading
           [:p {:class (stl/css :muted)} (tr "penforge.folder-browser.loading")]

           (and loaded (empty? items))
           [:p {:class (stl/css :muted)} (tr "penforge.folder-browser.empty")]

           loaded
           [:ul {:class (stl/css :list)
                 :aria-label (tr "penforge.folder-browser.folders")}
            (for [entry items]
              [:> folder-row* {:key (:path entry)
                               :entry entry
                               :icon (if (nil? path) i/board i/folder)
                               :on-open on-open}])]

           :else
           nil)
         (when (and loaded truncated)
           [:p {:class (stl/css :muted)} (tr "penforge.folder-browser.truncated")])]])

     (when (and loaded (string? path))
       [:div {:class (stl/css :facts)}
        [:> text* {:as "span" :typography t/body-small :class (stl/css :picked)}
         (tr "penforge.folder-browser.picked")]
        (for [badge badges]
          [:span {:key badge :class (stl/css :badge)} badge])])

     (cond
       (= :failed status)
       [:p {:class (stl/css :status :status-error) :role "alert"} (error-text error)]

       (and loaded (string? path) (some? problem))
       [:p {:class (stl/css :status :status-error) :role "alert"} (problem-text problem)]

       :else
       nil)]))
