;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.linked.panel
  "Cards of Game UI and Existing projects in the AI chat (W38): the
  background read of the linked folder (progress, retry, pick the
  folder again) and the Re-Design flow (confirm, progress, summary with
  a revert of changes outside the look).

  `read-card*` and `redesign-card*` render from plain props (tests
  render them); `linked-project-panel*` wires them to the state."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.redesign-code :as redesign]
   [app.main.data.ai.linked :as linked]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.folder-browser.browser :refer [folder-browser*
                                                                  error-text]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn step-text
  "Translated text of a progress step of `project-read`,
  `code-redesign` or `game-ui-export`; the daemon's English text for
  unknown steps."
  [{:keys [step text]}]
  (case step
    "inventory"  (tr "penforge.linked.step.inventory")
    "read"       (tr "penforge.linked.step.read")
    "brief"      (tr "penforge.linked.step.brief")
    "git"        (tr "penforge.redesign.step.git")
    "checkpoint" (tr "penforge.redesign.step.checkpoint")
    "screens"    (tr "penforge.redesign.step.screens")
    "edit"       (tr "penforge.redesign.step.edit")
    "guard"      (tr "penforge.redesign.step.guard")
    "assets"     (tr "penforge.redesign.step.assets")
    "tokens"     (tr "penforge.redesign.step.tokens")
    "guides"     (tr "penforge.redesign.step.guides")
    "commit"     (tr "penforge.redesign.step.commit")
    (when (string? text) text)))

;; --- Background read

(mf/defc read-card*
  "Props: `read` state, `platform`, `browser` and `link` states (folder
  picked again), `desktop`, callbacks `on-retry`, `on-open`,
  `on-choose`, `on-link`."
  [{:keys [read platform browser link desktop on-retry on-open on-choose on-link]}]
  (let [{:keys [status error]} read
        progress (linked/read-progress read)
        folder   (when (and (= :loaded (:status browser)) (string? (:path browser)))
                   {:path (:path browser) :facts (:facts browser)})
        problem  (linked/folder-problem platform folder)
        linking  (= :pending (:status link))

        link-folder
        (mf/use-fn
         (mf/deps folder on-link)
         (fn [_] (when folder (on-link (:path folder)))))]

    (cond
      (= :ready status)
      nil

      (= :failed status)
      [:section {:class (stl/css :card :card-error)
                 :role "alert"
                 :data-testid "penforge-read-failed"}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (tr "penforge.linked.read-failed")]
       (when (string? (:message error))
         [:p {:class (stl/css :detail)} (:message error)])
       [:div {:class (stl/css :actions)}
        [:> button* {:variant "secondary" :type "button" :on-click on-retry}
         (tr "penforge.linked.retry")]]]

      (= :not-linked status)
      [:section {:class (stl/css :card)
                 :data-testid "penforge-read-relink"}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (tr "penforge.linked.relink")]
       [:> folder-browser* {:browser browser
                            :platform platform
                            :desktop desktop
                            :disabled linking
                            :on-open on-open
                            :on-choose on-choose}]
       (when (= :failed (:status link))
         [:p {:class (stl/css :detail :detail-error) :role "alert"}
          (error-text (:error link))])
       [:div {:class (stl/css :actions)}
        [:> button* {:variant "primary"
                     :type "button"
                     :disabled (or linking (some? problem))
                     :on-click link-folder}
         (tr "penforge.linked.link")]]]

      :else
      [:section {:class (stl/css :card)
                 :aria-busy true
                 :data-testid "penforge-read-running"}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (tr "penforge.linked.reading")]
       [:p {:class (stl/css :detail)}
        (or (step-text (:progress read))
            (tr "penforge.linked.reading-hint"))
        (when progress
          [:span {:class (stl/css :count)}
           (tr "penforge.linked.reading-count" (:done progress) (:total progress))])]])))

;; --- Re-Design

(mf/defc confirm-body*
  {::mf/private true}
  [{:keys [workflow plan]}]
  (let [{:keys [branch continuing git dirty screens folder]} plan
        screens (count screens)]
    (if (= workflow "game-ui-export")
      [:*
       [:p {:class (stl/css :detail)}
        (tr "penforge.redesign.confirm.game" (or folder "PenforgeUI"))]
       [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.game-safe")]
       (when (and git (string? branch))
         [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.branch" branch)])
       (when-not git
         [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.game-no-git")])
       [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.screens" screens)]]
      [:*
       (when (string? branch)
         [:p {:class (stl/css :detail)}
          (if continuing
            (tr "penforge.redesign.confirm.continue-branch" branch)
            (tr "penforge.redesign.confirm.branch" branch))])
       [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.look-only")]
       (when-not git
         [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.no-git")])
       (when dirty
         [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.dirty")])
       [:p {:class (stl/css :detail)} (tr "penforge.redesign.confirm.screens" screens)]])))

(mf/defc summary-body*
  {::mf/private true}
  [{:keys [workflow result on-revert busy]}]
  (let [{:keys [kind] :as data} (redesign/summary-data workflow result)
        outside (:outside data)

        revert-all
        (mf/use-fn
         (mf/deps outside on-revert)
         (fn [_] (on-revert (mapv :path outside))))]
    (if (= kind :game)
      [:*
       [:p {:class (stl/css :detail)}
        (tr "penforge.redesign.done.game" (:screens data) (:pngs data) (:guides data) (:assets data))]
       (when (string? (:folder data))
         [:p {:class (stl/css :detail :path)} (:folder data)])
       (when (string? (:branch data))
         [:p {:class (stl/css :detail)} (tr "penforge.redesign.done.branch" (:branch data))])]
      [:*
       [:p {:class (stl/css :detail)}
        (tr "penforge.redesign.done.existing" (:files data) (:screens-done data) (:screens-partial data))]
       (when (string? (:branch data))
         [:p {:class (stl/css :detail)} (tr "penforge.redesign.done.branch" (:branch data))])
       (when (seq (:unmatched data))
         [:div {:class (stl/css :list-block)}
          [:p {:class (stl/css :detail)} (tr "penforge.redesign.done.unmatched")]
          [:ul {:class (stl/css :list)}
           (for [item (:unmatched data)]
             [:li {:key (str item)} (str item)])]])
       (when (seq outside)
         [:div {:class (stl/css :list-block)
                :data-testid "penforge-redesign-outside"}
          [:p {:class (stl/css :detail :detail-error)} (tr "penforge.redesign.done.outside")]
          [:ul {:class (stl/css :list)}
           (for [{:keys [path detail]} outside]
             [:li {:key path}
              [:span {:class (stl/css :path)} path]
              (when (string? detail)
                [:span {:class (stl/css :muted)} (str " — " detail)])])]
          [:div {:class (stl/css :actions)}
           [:> button* {:variant "secondary"
                        :type "button"
                        :disabled busy
                        :on-click revert-all}
            (tr "penforge.redesign.done.revert")]]])])))

(mf/defc redesign-card*
  "Props: `redesign` state, callbacks `on-confirm` (fn of the optional
  instructions), `on-revert` (fn of paths), `on-dismiss`."
  [{:keys [redesign on-confirm on-revert on-dismiss]}]
  (let [{:keys [status workflow plan result error progress]} redesign
        instructions* (mf/use-state "")
        instructions  (deref instructions*)

        on-instructions
        (mf/use-fn #(reset! instructions* (dom/get-target-val %)))

        confirm
        (mf/use-fn
         (mf/deps instructions on-confirm)
         (fn [_] (on-confirm instructions)))]

    (cond
      (nil? status)
      nil

      (= :planning status)
      [:section {:class (stl/css :card) :aria-busy true}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (tr "penforge.redesign.planning")]]

      (= :confirm status)
      [:section {:class (stl/css :card)
                 :data-testid "penforge-redesign-confirm"}
       [:> text* {:as "h3" :typography t/headline-small :class (stl/css :title)}
        (tr "penforge.redesign.confirm.title")]
       [:> confirm-body* {:workflow workflow :plan plan}]
       (when (= workflow "code-redesign")
         [:textarea {:class (stl/css :field)
                     :rows 2
                     :value instructions
                     :aria-label (tr "penforge.redesign.instructions")
                     :placeholder (tr "penforge.redesign.instructions-placeholder")
                     :on-change on-instructions}])
       [:div {:class (stl/css :actions)}
        [:> button* {:variant "secondary" :type "button" :on-click on-dismiss}
         (tr "labels.cancel")]
        [:> button* {:variant "primary" :type "button" :on-click confirm}
         (tr "penforge.redesign.action")]]]

      (contains? #{:running :reverting} status)
      [:section {:class (stl/css :card) :aria-busy true}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (if (= :reverting status)
          (tr "penforge.redesign.reverting")
          (tr "penforge.redesign.running"))]
       (when-let [text (step-text progress)]
         [:p {:class (stl/css :detail)} text])]

      (= :done status)
      [:section {:class (stl/css :card)
                 :data-testid "penforge-redesign-done"}
       [:> text* {:as "h3" :typography t/headline-small :class (stl/css :title)}
        (tr "penforge.redesign.done.title")]
       [:> summary-body* {:workflow workflow
                          :result result
                          :busy false
                          :on-revert on-revert}]
       [:div {:class (stl/css :actions)}
        [:> button* {:variant "ghost" :type "button" :on-click on-dismiss}
         (tr "labels.close")]]]

      (= :cancelled status)
      [:section {:class (stl/css :card)}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (tr "penforge.redesign.cancelled")]
       [:div {:class (stl/css :actions)}
        [:> button* {:variant "ghost" :type "button" :on-click on-dismiss}
         (tr "labels.close")]]]

      :else
      [:section {:class (stl/css :card :card-error) :role "alert"}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :title)}
        (tr "penforge.redesign.failed")]
       (when (string? (:message error))
         [:p {:class (stl/css :detail)} (:message error)])
       [:div {:class (stl/css :actions)}
        [:> button* {:variant "ghost" :type "button" :on-click on-dismiss}
         (tr "labels.close")]]])))

;; --- Panel

(def ^:private ref:panel
  (l/derived (fn [state]
               (let [platform (pf/current-platform state)]
                 (when (pf/linked-platform? platform)
                   {:platform platform
                    :read     (linked/get-read state)
                    :browser  (get-in state [:penforge :linked :browser])
                    :link     (get-in state [:penforge :linked :link])
                    :redesign (redesign/get-redesign state)})))
             st/state
             =))

(mf/defc linked-project-panel*
  "The cards of the open linked project; nothing for other projects."
  []
  (let [panel   (mf/deref ref:panel)
        desktop (some? (linked/desktop-bridge))

        on-retry   (mf/use-fn #(st/emit! (linked/start-read true)))
        on-open    (mf/use-fn #(st/emit! (linked/list-folder %)))
        on-choose  (mf/use-fn #(st/emit! (linked/choose-native-folder)))
        on-link    (mf/use-fn #(st/emit! (linked/link-current-project %)))
        on-confirm (mf/use-fn #(st/emit! (redesign/confirm-redesign %)))
        on-revert  (mf/use-fn #(st/emit! (redesign/revert-outside %)))
        on-dismiss (mf/use-fn #(st/emit! (redesign/dismiss-redesign)))
        not-linked (= :not-linked (get-in panel [:read :status]))]

    ;; the folder browser starts at the drives once the folder is needed
    (mf/with-effect [not-linked]
      (when not-linked
        (st/emit! (linked/list-folder nil))))

    (when (some? panel)
      [:div {:class (stl/css :panel)}
       [:> read-card* {:read (:read panel)
                       :platform (:platform panel)
                       :browser (:browser panel)
                       :link (:link panel)
                       :desktop desktop
                       :on-retry on-retry
                       :on-open on-open
                       :on-choose on-choose
                       :on-link on-link}]
       [:> redesign-card* {:redesign (:redesign panel)
                           :on-confirm on-confirm
                           :on-revert on-revert
                           :on-dismiss on-dismiss}]])))
