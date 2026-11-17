;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.checkpoints.history
  "AI history dialog (W19): the checkpoints saved before AI changes,
  with \"Go back\" and, for developers, \"Compare\" (code diff since the
  checkpoint). Opened by the `:ai/checkpoints` action."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.time :as ct]
   [app.main.data.ai.actions.checkpoints :as dac]
   [app.main.data.ai.client :as client]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:checkpoints
  (l/derived #(get-in % dac/state-path dac/empty-state) st/state))

(def ^:private ref:persona
  (l/derived client/get-persona st/state))

(def ^:private ref:connected
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(def ^:private ref:file-id
  (l/derived :current-file-id st/state))

(def ^:private ref:can-edit
  (l/derived dac/can-edit? st/state))

(defn- format-date
  [at]
  (when-let [date (ct/inst at)]
    (ct/format-inst date :localized-date-time)))

(defn- format-ago
  [at]
  (when-let [date (ct/inst at)]
    (ct/timeago date)))

;; --- Diff (developer)

(mf/defc repo-diff*
  {::mf/private true}
  [{:keys [title diff]}]
  (let [{:keys [stat patch truncated untracked]} diff]
    [:section {:class (stl/css :diff-repo)}
     [:> text* {:as "h4" :typography t/body-small :class (stl/css :diff-title)} title]
     (if (and (empty? stat) (empty? untracked))
       [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
        (tr "penforge.checkpoints.diff.none")]
       [:*
        (when (seq stat)
          [:pre {:class (stl/css :diff-stat)} stat])
        (when (seq untracked)
          [:pre {:class (stl/css :diff-stat)}
           (str (tr "penforge.checkpoints.diff.untracked") "\n"
                (apply str (interpose "\n" untracked)))])
        (when (seq patch)
          [:pre {:class (stl/css :diff-patch)} patch])
        (when truncated
          [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
           (tr "penforge.checkpoints.diff.truncated")])])]))

(mf/defc checkpoint-diff*
  {::mf/private true}
  [{:keys [checkpoint diff]}]
  (let [{:keys [status data error]} diff]
    [:div {:class (stl/css :diff)
           :data-testid "ai-checkpoint-diff"}
     (cond
       (= status :loading)
       [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
        (tr "penforge.checkpoints.diff.loading")]

       (= status :error)
       [:> text* {:as "p" :typography t/body-small :class (stl/css :error)}
        (tr "penforge.checkpoints.diff.failed" (str error))]

       :else
       [:*
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.checkpoints.diff.hint" (:tag checkpoint))]
        [:> repo-diff* {:title (tr "penforge.checkpoints.diff.app-src")
                        :diff (:app-src data)}]
        [:> repo-diff* {:title (tr "penforge.checkpoints.diff.design")
                        :diff (:design data)}]])]))

;; --- List

(mf/defc checkpoint-item*
  {::mf/private true}
  [{:keys [checkpoint developer can-edit file-id busy connected undo-target diff
           confirming on-confirm on-cancel]}]
  (let [{:keys [id n label workflow at restored-at]} checkpoint
        other-file (dac/other-file? checkpoint file-id)
        restoring  (= busy id)
        disabled   (or (not connected) (some? busy) other-file)

        on-ask
        (mf/use-fn (mf/deps id on-confirm) #(on-confirm id))

        on-restore
        (mf/use-fn
         (mf/deps id on-cancel)
         (fn []
           (on-cancel)
           (st/emit! (dac/restore-checkpoint {:id id}))))

        on-compare
        (mf/use-fn
         (mf/deps id diff)
         (fn []
           (st/emit! (if (some? diff)
                       (dac/hide-diff id)
                       (dac/fetch-diff id)))))]

    [:li {:class (stl/css :item)
          :data-testid "ai-checkpoint"}
     [:div {:class (stl/css :item-row)}
      [:div {:class (stl/css :item-main)}
       [:> text* {:as "span" :typography t/body-medium :class (stl/css :item-label)}
        (str "#" n " · " label)]
       [:> text* {:as "span" :typography t/body-small :class (stl/css :muted)
                  :title (format-date at)}
        (str (dac/workflow-label workflow) " · " (format-ago at))]
       [:div {:class (stl/css :badges)}
        (when undo-target
          [:span {:class (stl/css :badge :badge-accent)}
           (tr "penforge.checkpoints.badge.undo-target")])
        (when restored-at
          [:span {:class (stl/css :badge)}
           (tr "penforge.checkpoints.badge.restored")])
        (when (dac/code-only? checkpoint)
          [:span {:class (stl/css :badge)
                  :title (first (:warnings checkpoint))}
           (tr "penforge.checkpoints.badge.code-only")])
        (when other-file
          [:span {:class (stl/css :badge)}
           (tr "penforge.checkpoints.badge.other-file"
               (or (get-in checkpoint [:file-version :file-name]) ""))])]]

      [:div {:class (stl/css :item-actions)}
       (when developer
         [:> button* {:variant "ghost"
                      :disabled (not connected)
                      :on-click on-compare}
          (if (some? diff)
            (tr "penforge.checkpoints.compare.hide")
            (tr "penforge.checkpoints.compare"))])
       (when can-edit
         [:> button* {:variant "secondary"
                      :disabled (or disabled confirming)
                      :on-click on-ask}
          (if restoring
            (tr "penforge.checkpoints.restoring")
            (tr "penforge.checkpoints.restore"))])]]

     (when (and can-edit confirming)
       [:div {:class (stl/css :confirm)
              :role "alert"}
        [:> text* {:as "p" :typography t/body-small}
         (tr "penforge.checkpoints.restore.question" label)]
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.checkpoints.restore.warning")]
        [:div {:class (stl/css :confirm-actions)}
         [:> button* {:variant "secondary" :on-click on-cancel}
          (tr "penforge.checkpoints.restore.cancel")]
         [:> button* {:variant "primary" :on-click on-restore}
          (tr "penforge.checkpoints.restore.accept")]]])

     (when (and developer (some? diff))
       [:> checkpoint-diff* {:checkpoint checkpoint :diff diff}])]))

(mf/defc checkpoint-list*
  [{:keys [checkpoints developer can-edit file-id connected]}]
  (let [confirming* (mf/use-state nil)
        confirming  (deref confirming*)

        on-confirm
        (mf/use-fn #(reset! confirming* %))

        on-cancel
        (mf/use-fn #(reset! confirming* nil))

        {:keys [status items busy diffs undo-target-id]} checkpoints]

    (cond
      (not connected)
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :message)}
       (tr "penforge.checkpoints.not-connected")]

      (and (= status :error) (empty? items))
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :message :error)}
       (tr "penforge.checkpoints.load-failed")]

      (and (contains? #{:idle :loading} status) (empty? items))
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :message :muted)}
       (tr "penforge.checkpoints.loading")]

      (empty? items)
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :message :muted)}
       (tr "penforge.checkpoints.empty")]

      :else
      [:ol {:class (stl/css :list)
            :aria-busy (= status :loading)}
       (for [checkpoint items]
         (let [id (:id checkpoint)]
           [:> checkpoint-item* {:key id
                                 :checkpoint checkpoint
                                 :developer developer
                                 :can-edit can-edit
                                 :file-id file-id
                                 :busy busy
                                 :connected connected
                                 :undo-target (= id undo-target-id)
                                 :diff (get diffs id)
                                 :confirming (= id confirming)
                                 :on-confirm on-confirm
                                 :on-cancel on-cancel}]))])))

;; --- Dialog

(mf/defc checkpoints-dialog*
  {::mf/register modal/components
   ::mf/register-as :penforge-checkpoints}
  []
  (let [checkpoints (mf/deref ref:checkpoints)
        persona     (mf/deref ref:persona)
        connected   (mf/deref ref:connected)
        file-id     (mf/deref ref:file-id)
        can-edit    (mf/deref ref:can-edit)
        busy        (:busy checkpoints)

        on-close
        (mf/use-fn #(st/emit! (modal/hide)))

        on-create
        (mf/use-fn #(st/emit! (dac/create-checkpoint)))

        on-reload
        (mf/use-fn #(st/emit! (dac/fetch-checkpoints)))]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "ai-checkpoints-title"
            :data-testid "ai-checkpoints-dialog"}
      [:> icon-button* {:variant "ghost"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click on-close}]
      [:> text* {:as "h2" :id "ai-checkpoints-title"
                 :typography t/headline-medium :class (stl/css :modal-title)}
       (tr "penforge.checkpoints.title")]
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
       (tr "penforge.checkpoints.intro")]

      [:div {:class (stl/css :toolbar)}
       (if can-edit
         [:> button* {:variant "secondary"
                      :icon i/add
                      :disabled (or (not connected) (some? busy))
                      :on-click on-create}
          (if (= busy :create)
            (tr "penforge.checkpoints.creating")
            (tr "penforge.checkpoints.create"))]
         [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
          (tr "penforge.checkpoints.no-edit-rights")])
       [:> icon-button* {:variant "ghost"
                         :icon i/reload
                         :disabled (not connected)
                         :aria-label (tr "penforge.checkpoints.reload")
                         :on-click on-reload}]]

      [:div {:class (stl/css :modal-content)}
       [:> checkpoint-list* {:checkpoints checkpoints
                             :developer (= persona :developer)
                             :can-edit can-edit
                             :file-id file-id
                             :connected connected}]]]]))
