;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.panel
  "The AI tab of the workspace left sidebar."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.linked :as linked]
   [app.main.data.helpers :as dsh]
   [app.main.refs :as refs]
   [app.main.render :as render]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu*
                                                 dropdown-menu-item*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.animations.play :as anim-play]
   [app.main.ui.workspace.ai.chat.banner :refer [connection-banner*]]
   [app.main.ui.workspace.ai.chat.files :as files]
   [app.main.ui.workspace.ai.chat.markdown :refer [markdown*]]
   [app.main.ui.workspace.ai.chat.status :refer [work-status*]]
   [app.main.ui.workspace.ai.design-system.binding.card :refer [design-system-binding*]]
   [app.main.ui.workspace.ai.design-system.start :refer [design-system-start*]]
   [app.main.ui.workspace.ai.detached.placeholder :refer [ref:detached? detach-button* detached-placeholder*]]
   [app.main.ui.workspace.ai.linked.panel :refer [linked-project-panel*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [app.util.shape-icon :as usi]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

(def ^:private ref:chat
  (l/derived #(get-in % [:penforge :chat]) st/state))

(def ^:private ref:connection
  (l/derived #(get-in % [:penforge :connection]) st/state))

(def ^:private ref:persona
  (l/derived client/get-persona st/state))

;; W38: the chat of a linked project waits for its background read
(def ^:private ref:locked
  (l/derived linked/chat-locked? st/state))

;; --- Attachments

(mf/defc node-thumbnail*
  {::mf/private true}
  [{:keys [node-id type]}]
  (let [objects  (mf/deref refs/workspace-page-objects)
        shape-id (uuid/parse* node-id)
        shape    (get objects shape-id)]
    (if (and (some? shape) (not= :text (:type shape)))
      [:span {:class (stl/css :thumbnail)}
       [:& render/object-svg {:objects objects
                              :object-id shape-id
                              :class (stl/css :thumbnail-svg)}]]
      [:span {:class (stl/css :thumbnail)}
       [:> icon* {:icon-id (or (some-> shape usi/get-shape-icon)
                               (usi/get-shape-icon-by-type (keyword type))
                               i/board)
                  :size "s"}]])))

(mf/defc file-thumbnail*
  {::mf/private true
   ::mf/memo true}
  [{:keys [mime base64]}]
  (let [group (files/group mime)
        ;; one object URL per file, not a data URL rebuilt on every render
        url   (mf/with-memo [mime base64]
                (when (and (= :image group) (some? base64))
                  (files/object-url mime base64)))]

    (mf/with-effect [url]
      (when url
        #(js/URL.revokeObjectURL url)))

    (if (some? url)
      [:span {:class (stl/css :thumbnail)}
       [:img {:class (stl/css :thumbnail-img)
              :src url
              :alt ""}]]
      [:span {:class (stl/css :thumbnail)}
       [:> icon* {:icon-id (cond
                             (= :image group) i/img
                             (= :pdf group) i/document
                             :else i/text-paragraph)
                  :size "s"}]])))

(mf/defc attachment-chip*
  {::mf/private true
   ::mf/memo true}
  [{:keys [attachment on-remove]}]
  (let [{:keys [kind node-id name type mime base64 files]} attachment
        key (chat/attachment-key attachment)
        label (if (= "folder" kind)
                (tr "penforge.chat.attach.folder-label" name (count files))
                name)

        on-click
        (mf/use-fn
         (mf/deps key on-remove)
         #(on-remove key))]

    [:li {:class (stl/css :chip)}
     (case kind
       "file" [:> file-thumbnail* {:mime mime :base64 base64}]
       "folder" [:span {:class (stl/css :thumbnail)}
                 [:> icon* {:icon-id i/folder :size "s"}]]
       [:> node-thumbnail* {:node-id node-id :type type}])
     [:span {:class (stl/css :chip-name) :title label} label]
     (when on-remove
       [:> icon-button* {:variant "ghost"
                         :icon i/close-small
                         :icon-size "s"
                         :class (stl/css :chip-remove)
                         :aria-label (tr "penforge.chat.attachment.remove" name)
                         :on-click on-click}])]))

;; --- Timeline entries

(mf/defc message-actions*
  "Hover actions of a user message (W37): edit, delete, revert."
  {::mf/private true}
  [{:keys [on-edit on-delete on-revert]}]
  [:div {:class (stl/css :message-actions)
         :role "toolbar"
         :aria-label (tr "penforge.chat.message.actions")
         :data-testid "ai-chat-message-actions"}
   [:> icon-button* {:variant "ghost"
                     :icon i/pencil
                     :icon-size "s"
                     :aria-label (tr "penforge.chat.message.edit")
                     :on-click on-edit}]
   [:> icon-button* {:variant "ghost"
                     :icon i/history
                     :icon-size "s"
                     :aria-label (tr "penforge.chat.message.revert")
                     :on-click on-revert}]
   [:> icon-button* {:variant "ghost"
                     :icon i/delete
                     :icon-size "s"
                     :aria-label (tr "penforge.chat.message.delete")
                     :on-click on-delete}]])

(mf/defc message-editor*
  "The text of a user message being edited (W37): Enter or Save sends it
  again, Escape or Cancel leaves it."
  {::mf/private true}
  [{:keys [text on-save on-cancel]}]
  (let [draft*   (mf/use-state text)
        draft    (deref draft*)
        blank    (str/blank? draft)

        on-change
        (mf/use-fn #(reset! draft* (dom/get-target-val %)))

        on-submit
        (mf/use-fn
         (mf/deps draft on-save)
         (fn [event]
           (some-> event dom/prevent-default)
           (when-not (str/blank? draft)
             (on-save draft))))

        on-key-down
        (mf/use-fn
         (mf/deps on-submit on-cancel)
         (fn [event]
           (cond
             (and (kbd/enter? event)
                  (not (kbd/shift? event))
                  (not (.-isComposing ^js (.-nativeEvent event))))
             (on-submit event)

             (kbd/esc? event)
             (do (dom/stop-propagation event)
                 (on-cancel)))))]

    [:form {:class (stl/css :message-editor)
            :on-submit on-submit}
     [:textarea {:class (stl/css :input :editor-input)
                 :value draft
                 :rows 3
                 :auto-focus true
                 :aria-label (tr "penforge.chat.message.edit-label")
                 :on-change on-change
                 :on-key-down on-key-down}]
     [:div {:class (stl/css :card-actions)}
      [:> button* {:variant "secondary" :type "button" :on-click on-cancel}
       (tr "penforge.chat.message.cancel")]
      [:> button* {:variant "primary" :type "submit" :disabled blank}
       (tr "penforge.chat.message.send-edit")]]]))

(mf/defc revert-confirm*
  "The one question before a revert (W37)."
  {::mf/private true}
  [{:keys [on-confirm on-cancel]}]
  [:div {:class (stl/css :card :revert-confirm)
         :role "alertdialog"
         :aria-label (tr "penforge.chat.message.revert")}
   [:> text* {:as "p" :typography t/body-small}
    (tr "penforge.chat.message.revert-question")]
   [:div {:class (stl/css :card-actions)}
    [:> button* {:variant "secondary" :on-click on-cancel}
     (tr "penforge.chat.message.cancel")]
    [:> button* {:variant "primary" :on-click on-confirm}
     (tr "penforge.chat.message.revert-confirm")]]])

(mf/defc user-entry*
  {::mf/private true}
  [{:keys [entry can-act]}]
  (let [{:keys [id text attachments]} entry
        ;; nil, :edit or :revert (asking first)
        mode*  (mf/use-state nil)
        mode   (deref mode*)

        on-edit
        (mf/use-fn #(reset! mode* :edit))

        on-revert
        (mf/use-fn #(reset! mode* :revert))

        on-close
        (mf/use-fn #(reset! mode* nil))

        on-save
        (mf/use-fn
         (mf/deps id)
         (fn [draft]
           (reset! mode* nil)
           (st/emit! (chat/edit-message id draft))))

        on-delete
        (mf/use-fn
         (mf/deps id)
         #(st/emit! (chat/delete-message id)))

        on-confirm-revert
        (mf/use-fn
         (mf/deps id)
         (fn []
           (reset! mode* nil)
           (st/emit! (chat/revert-message id))))]

    [:li {:class (stl/css :entry :entry-user-row)
          :data-testid "ai-chat-user-message"}
     (if (and (= mode :edit) can-act)
       [:> message-editor* {:text text :on-save on-save :on-cancel on-close}]
       [:div {:class (stl/css :entry-user)}
        (when (seq attachments)
          [:ul {:class (stl/css :chips)}
           (for [[index attachment] (map-indexed vector attachments)]
             [:> attachment-chip* {:key (str index "-" (chat/attachment-key attachment))
                                   :attachment attachment}])])
        [:> text* {:as "p"
                   :typography t/body-medium
                   :class (stl/css :user-text)}
         text]])
     (cond
       (not can-act)
       nil

       (= mode :revert)
       [:> revert-confirm* {:on-confirm on-confirm-revert :on-cancel on-close}]

       (nil? mode)
       [:> message-actions* {:on-edit on-edit
                             :on-delete on-delete
                             :on-revert on-revert}])]))

(mf/defc notice-entry*
  "A line about what a message action did (W37)."
  {::mf/private true}
  [{:keys [entry]}]
  [:li {:class (stl/css :entry :entry-notice)}
   [:> icon* {:icon-id i/history :size "s"}]
   [:> text* {:as "p" :typography t/body-small}
    (if (= "reverted" (:code entry))
      (tr "penforge.chat.message.reverted")
      (tr "penforge.chat.message.reverted-unchanged"))]])

(mf/defc assistant-entry*
  {::mf/private true}
  [{:keys [entry]}]
  [:li {:class (stl/css :entry :entry-assistant)}
   [:> markdown* {:text (:text entry)
                  :streaming (boolean (:streaming entry))}]
   (when (:streaming entry)
     [:span {:class (stl/css :caret) :aria-hidden true}])])

(mf/defc status-icon*
  {::mf/private true}
  [{:keys [status]}]
  (case status
    :done [:> icon* {:icon-id i/tick :size "s" :class (stl/css :tool-done)}]
    :error [:> icon* {:icon-id i/status-wrong :size "s" :class (stl/css :tool-error)}]
    [:span {:class (stl/css :spinner) :aria-hidden true}]))

(defn- tool-summary
  "Text of a step line: the daemon's summary, or the translation of its
  check code (W25)."
  [{:keys [code params summary]}]
  (case code
    "boards-overlap"
    (let [[a b] (:names params)]
      (tr "penforge.chat.check.boards-overlap" a b))

    "style-differs"
    (let [{:keys [board source layers]} params]
      (tr "penforge.chat.check.style-differs" board source (str/join ", " layers)))

    ;; W32: layers the turn animated
    "animations-set"
    (anim-play/step-text params)

    summary))

(mf/defc tool-entry*
  {::mf/private true}
  [{:keys [entry persona]}]
  (let [{:keys [status tool-name detail]} entry
        summary     (tool-summary entry)
        status-icon (mf/html [:> status-icon* {:status status}])]
    [:li {:class (stl/css :entry :entry-tool)}
     (if (and (= persona :developer) (or detail tool-name))
       [:details {:class (stl/css :tool-details)}
        [:summary {:class (stl/css :tool-line)}
         status-icon
         [:span {:class (stl/css :tool-summary)} summary]]
        [:pre {:class (stl/css :tool-detail)}
         (str tool-name (when detail (str "\n" detail)))]]
       [:div {:class (stl/css :tool-line)}
        status-icon
        [:span {:class (stl/css :tool-summary)} summary]])
     (when (= anim-play/code (:code entry))
       [:> anim-play/animation-play* {:entry entry}])]))

(defn- get-error-text
  [{:keys [code message reason params]}]
  (let [{:keys [name limit limit-mb]} params]
    (case reason
      "file-type" (tr "penforge.chat.attach.error.type" name)
      "file-size" (tr "penforge.chat.attach.error.size" name limit-mb)
      "file-count" (tr "penforge.chat.attach.error.count" limit)
      "files-total" (tr "penforge.chat.attach.error.total" limit-mb)
      ("file-read" "file-incomplete") (tr "penforge.chat.attach.error.read" name)
      "folder-empty" (tr "penforge.chat.attach.error.folder-empty" name)
      "folder-count" (tr "penforge.chat.attach.error.folder-count" name limit)
      "folder-file-size" (tr "penforge.chat.attach.error.folder-size" name limit-mb)
      "folder-path" (tr "penforge.chat.attach.error.read" name)
      (case code
        "not-connected" (tr "penforge.chat.error.not-connected")
        "busy" (tr "penforge.chat.error.busy")
        "no-context" (tr "penforge.chat.error.no-context")
        "not-configured" (tr "penforge.chat.error.not-configured")
        "not-implemented" (tr "penforge.chat.error.not-implemented")
        (or message (tr "penforge.chat.error.generic"))))))

(mf/defc error-entry*
  {::mf/private true}
  [{:keys [entry persona]}]
  [:li {:class (stl/css :entry :entry-error) :role "alert"}
   [:> icon* {:icon-id i/msg-error :size "s" :class (stl/css :error-icon)}]
   [:div {:class (stl/css :error-body)}
    [:> text* {:as "p" :typography t/body-small}
     (get-error-text entry)]
    (when (and (= persona :developer) (:message entry) (:code entry))
      [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
       (str (:code entry) ": " (:message entry))])]])

(mf/defc permission-entry*
  {::mf/private true}
  [{:keys [entry]}]
  (let [{:keys [id title description risk answer]} entry

        on-allow
        (mf/use-fn (mf/deps id) #(st/emit! (chat/respond-permission id true)))

        on-always
        (mf/use-fn (mf/deps id) #(st/emit! (chat/respond-permission id true :remember true)))

        on-deny
        (mf/use-fn (mf/deps id) #(st/emit! (chat/respond-permission id false)))]

    [:li {:class (stl/css :entry :card)}
     [:div {:class (stl/css :card-header)}
      [:> text* {:as "h4" :typography t/body-medium :class (stl/css :card-title)} title]
      [:span {:class (stl/css-case :risk true
                                   :risk-low (= risk :low)
                                   :risk-medium (= risk :medium)
                                   :risk-high (= risk :high))}
       (case risk
         :high (tr "penforge.chat.permission.risk-high")
         :medium (tr "penforge.chat.permission.risk-medium")
         (tr "penforge.chat.permission.risk-low"))]]
     (when (seq description)
       [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)} description])
     (case answer
       :allowed
       [:> text* {:as "p" :typography t/body-small :class (stl/css :answer)}
        (tr "penforge.chat.permission.allowed")]

       :denied
       [:> text* {:as "p" :typography t/body-small :class (stl/css :answer)}
        (tr "penforge.chat.permission.denied")]

       [:div {:class (stl/css :card-actions)}
        [:> button* {:variant "primary" :on-click on-allow}
         (tr "penforge.chat.permission.allow")]
        [:> button* {:variant "secondary" :on-click on-always}
         (tr "penforge.chat.permission.always")]
        [:> button* {:variant "ghost" :on-click on-deny}
         (tr "penforge.chat.permission.deny")]])]))

(mf/defc question-option*
  {::mf/private true}
  [{:keys [run-id question-id option answer]}]
  (let [{:keys [id label]} option

        on-click
        (mf/use-fn
         (mf/deps run-id question-id id)
         #(st/emit! (chat/answer-question run-id question-id id)))]

    [:> button* {:variant (if (= answer id) "primary" "secondary")
                 :disabled (some? answer)
                 :on-click on-click}
     label]))

(mf/defc question-entry*
  {::mf/private true}
  [{:keys [entry]}]
  (let [{:keys [id run-id text options answer]} entry]
    [:li {:class (stl/css :entry :card)}
     [:> markdown* {:text text}]
     [:div {:class (stl/css :card-actions :card-options)}
      (for [option options]
        [:> question-option* {:key (:id option)
                              :run-id run-id
                              :question-id id
                              :option option
                              :answer answer}])]]))

(mf/defc workflow-entry*
  {::mf/private true}
  [{:keys [entry persona]}]
  (let [{:keys [name status summary error progress]} entry]
    [:li {:class (stl/css :entry :entry-tool)}
     [:div {:class (stl/css :tool-line)}
      [:> status-icon* {:status status}]
      [:span {:class (stl/css :tool-summary)}
       (or (not-empty summary)
           (when (string? progress) progress)
           (when (string? (:text progress)) (:text progress))
           (tr "penforge.chat.workflow.running"))]]
     (when (and error (= persona :developer))
       [:pre {:class (stl/css :tool-detail)} (str name "\n" error)])]))

(mf/defc step-item*
  {::mf/private true
   ::mf/memo true}
  [{:keys [entry persona]}]
  (case (:kind entry)
    :tool     [:> tool-entry* {:entry entry :persona persona}]
    :workflow [:> workflow-entry* {:entry entry :persona persona}]
    nil))

(mf/defc steps-entry*
  "The steps of one turn in one collapsible block above the answer:
  closed, it shows the running step (or how many steps ran); open, the
  full list."
  {::mf/private true
   ::mf/memo true}
  [{:keys [entry persona]}]
  (let [steps    (:entries entry)
        status   (chat/steps-status steps)
        failed   (count (filter #(= :error (:status %)) steps))
        current  (when (= status :running)
                   (last (filter #(= :running (:status %)) steps)))
        label    (if current
                   (or (not-empty (tool-summary current))
                       (not-empty (:summary current))
                       (tr "penforge.chat.status.working"))
                   (tr "penforge.chat.steps.count" (count steps)))]
    [:li {:class (stl/css :entry :entry-steps)}
     [:details {:class (stl/css :steps-details)}
      [:summary {:class (stl/css :steps-summary)}
       [:> status-icon* {:status status}]
       [:span {:class (stl/css :tool-summary)} label]
       (when (pos? failed)
         [:span {:class (stl/css :steps-retried)}
          (tr "penforge.chat.steps.retried" failed)])
       [:> icon* {:icon-id i/arrow-right :size "s" :class (stl/css :steps-arrow)}]]
      [:ol {:class (stl/css :steps-list)}
       (for [step steps]
         [:> step-item* {:key (str (name (:kind step)) "-" (:id step))
                         :entry step
                         :persona persona}])]]]))

(mf/defc entry*
  {::mf/private true
   ::mf/memo true}
  [{:keys [entry persona can-act]}]
  (case (:kind entry)
    :steps      [:> steps-entry* {:entry entry :persona persona}]
    :user       [:> user-entry* {:entry entry :can-act can-act}]
    :notice     [:> notice-entry* {:entry entry}]
    :assistant  [:> assistant-entry* {:entry entry}]
    :tool       [:> tool-entry* {:entry entry :persona persona}]
    :error      [:> error-entry* {:entry entry :persona persona}]
    :permission [:> permission-entry* {:entry entry}]
    :question   [:> question-entry* {:entry entry}]
    :workflow   [:> workflow-entry* {:entry entry :persona persona}]
    nil))

(mf/defc timeline*
  {::mf/private true}
  [{:keys [entries status persona can-act]}]
  (let [list-ref (mf/use-ref nil)]

    ;; Follow the conversation while it grows.
    (mf/with-effect [entries]
      (when-let [node (mf/ref-val list-ref)]
        (set! (.-scrollTop node) (.-scrollHeight node))))

    (if (empty? entries)
      [:div {:class (stl/css :empty)}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
        (tr "penforge.chat.empty")]]
      [:ol {:class (stl/css :timeline)
            :ref list-ref
            ;; lets Ctrl/Cmd+C copy selected chat text (see app.main.data.shortcuts)
            :data-copyable-text true
            :aria-live "polite"
            :aria-busy (= status :streaming)}
       (for [entry (chat/timeline-items entries)]
         [:> entry* {:key (str (name (:kind entry)) "-" (:id entry))
                     :entry entry
                     :persona persona
                     :can-act can-act}])])))

;; --- Composer

(def ^:private ref:selected
  (l/derived #(dsh/get-selected-ids %) st/state =))

(mf/defc selection-chip*
  "The canvas selection the next message takes as context (W25); the
  user can leave it out."
  {::mf/private true}
  [{:keys [chat]}]
  (let [selected (mf/deref ref:selected)
        objects  (mf/deref refs/workspace-page-objects)
        context  (chat/selection-context chat selected objects nil nil)
        names    (mapv :name context)
        label    (if (= 1 (count names))
                   (first names)
                   (tr "penforge.chat.selection.many" (count names)))

        on-remove
        (mf/use-fn
         (mf/deps selected)
         #(st/emit! (chat/dismiss-selection selected)))

        dismissed (:dismissed-selection chat)]

    ;; a removed selection is forgotten once the selection changes
    (mf/with-effect [selected dismissed]
      (when (and (some? dismissed) (not= (set selected) dismissed))
        (st/emit! (chat/dismiss-selection nil))))

    (when (seq context)
      [:li {:class (stl/css :chip :chip-selection)
            :title (tr "penforge.chat.selection.title")
            :data-testid "ai-chat-selection"}
       (if (= 1 (count context))
         [:> node-thumbnail* {:node-id (:node-id (first context))
                              :type (:type (first context))}]
         [:span {:class (stl/css :thumbnail)}
          [:> icon* {:icon-id i/layers :size "s"}]])
       [:span {:class (stl/css :chip-name)} label]
       [:> icon-button* {:variant "ghost"
                         :icon i/close-small
                         :icon-size "s"
                         :class (stl/css :chip-remove)
                         :aria-label (tr "penforge.chat.selection.remove")
                         :on-click on-remove}]])))

(mf/defc attach-menu-item*
  {::mf/private true}
  [{:keys [icon label on-click]}]
  (let [on-key-down
        (mf/use-fn
         (mf/deps on-click)
         (fn [event]
           (when (kbd/enter? event)
             (on-click event))))]
    [:> dropdown-menu-item* {:class (stl/css :attach-menu-item)
                             :on-click on-click
                             :on-key-down on-key-down}
     [:> icon* {:icon-id icon
                :size "s"
                :class (stl/css :attach-menu-icon)}]
     [:span label]]))

(mf/defc composer*
  {::mf/private true}
  [{:keys [chat status connected locked]}]
  (let [text*        (mf/use-state "")
        text         (deref text*)
        problems*    (mf/use-state nil)
        problems     (deref problems*)
        dragging*    (mf/use-state false)
        dragging     (deref dragging*)
        input-ref    (mf/use-ref nil)
        folder-ref   (mf/use-ref nil)
        menu*        (mf/use-state false)
        menu-open    (deref menu*)
        reserved-ref (mf/use-ref [])
        attachments  (:attachments chat)
        ;; one turn at a time; workflow runs do not block the chat
        busy         (= status :streaming)

        ;; read by callbacks; a closure would see the attachments of the
        ;; render that made it
        pending-ref (mf/use-ref attachments)

        on-change
        (mf/use-fn #(reset! text* (dom/get-target-val %)))

        on-send
        (mf/use-fn
         (mf/deps text)
         (fn []
           (when (seq (.trim text))
             (st/emit! (chat/send-message text))
             (reset! problems* nil)
             (reset! text* ""))))

        on-submit
        (mf/use-fn
         (mf/deps on-send busy)
         (fn [event]
           (dom/prevent-default event)
           (when-not busy
             (on-send))))

        on-key-down
        (mf/use-fn
         (mf/deps on-send busy)
         (fn [event]
           (when (and (kbd/enter? event)
                      (not (kbd/shift? event))
                      (not (.-isComposing ^js (.-nativeEvent event))))
             (dom/prevent-default event)
             (when-not busy
               (on-send)))))

        add-files
        (mf/use-fn
         (fn [js-files]
           (when (pos? (.-length js-files))
             ;; files still being read hold their room, so two quick drops
             ;; cannot both pass the limits
             (let [reserved (mf/ref-val reserved-ref)
                   {:keys [accepted problems]}
                   (files/check-browser-files (into (vec (mf/ref-val pending-ref)) reserved) js-files)
                   slots    (mapv (fn [{:keys [size]}]
                                    {:kind "file" :size size :slot (str (uuid/next))})
                                  accepted)]
               (mf/set-ref-val! reserved-ref (into reserved slots))
               (reset! problems* (not-empty problems))
               (->> (files/read-files accepted)
                    (p/fmap (fn [{added :attachments refused :problems}]
                              (mf/set-ref-val! reserved-ref
                                               (into [] (remove (set slots)) (mf/ref-val reserved-ref)))
                              (when (seq added)
                                (st/emit! (chat/add-files added)))
                              (when (seq refused)
                                (swap! problems* #(into (vec %) refused))))))))))

        add-folder
        (mf/use-fn
         (fn [js-files]
           (when (pos? (.-length js-files))
             (let [reserved (mf/ref-val reserved-ref)
                   {:keys [accepted problems]}
                   (files/check-folder (into (vec (mf/ref-val pending-ref)) reserved)
                                       (files/folder-entries js-files))]
               (reset! problems* (not-empty problems))
               (when (some? accepted)
                 ;; the folder holds its room while it is read
                 (let [slot {:kind "folder" :size (:size accepted) :slot (str (uuid/next))}]
                   (mf/set-ref-val! reserved-ref (conj reserved slot))
                   (->> (files/read-folder accepted)
                        (p/fmap (fn [{:keys [attachment problem]}]
                                  (mf/set-ref-val! reserved-ref
                                                   (into [] (remove #(= slot %)) (mf/ref-val reserved-ref)))
                                  (when (some? attachment)
                                    (st/emit! (chat/add-files [attachment])))
                                  (when (some? problem)
                                    (swap! problems* #(conj (vec %) problem))))))))))))

        toggle-menu
        (mf/use-fn
         (fn [event]
           ;; the open menu closes on any document click; keep this one
           ;; from reaching it
           (dom/stop-propagation event)
           (swap! menu* not)))

        close-menu
        (mf/use-fn #(reset! menu* false))

        on-pick
        (mf/use-fn
         (fn [_]
           (reset! menu* false)
           (some-> (mf/ref-val input-ref) dom/click)))

        on-pick-folder
        (mf/use-fn
         (fn [_]
           (reset! menu* false)
           (some-> (mf/ref-val folder-ref) dom/click)))

        on-folder-change
        (mf/use-fn
         (mf/deps add-folder)
         (fn [event]
           (let [target (dom/get-target event)
                 picked (js/Array.from (.-files ^js target))]
             (set! (.-value ^js target) "")
             (add-folder picked))))

        on-input-change
        (mf/use-fn
         (mf/deps add-files)
         (fn [event]
           (let [target (dom/get-target event)
                 picked (js/Array.from (.-files ^js target))]
             (set! (.-value ^js target) "")
             (add-files picked))))

        on-paste
        (mf/use-fn
         (mf/deps add-files)
         (fn [event]
           (let [clipboard (.-clipboardData ^js event)
                 pasted    (files/files-of clipboard)
                 ;; Office apps put a picture of copied text on the
                 ;; clipboard too: text wins
                 text      (some-> clipboard (.getData "text/plain"))]
             (when (and (pos? (.-length pasted)) (empty? text))
               (dom/prevent-default event)
               (dom/stop-propagation event)
               (add-files pasted)))))

        on-drag-over
        (mf/use-fn
         (fn [event]
           (let [types (some-> ^js event .-dataTransfer .-types)]
             (when (and types (.includes (js/Array.from types) "Files"))
               (dom/prevent-default event)
               (dom/stop-propagation event)
               (reset! dragging* true)))))

        on-drag-leave
        (mf/use-fn #(reset! dragging* false))

        on-drop
        (mf/use-fn
         (mf/deps add-files)
         (fn [event]
           (let [dropped (files/files-of (.-dataTransfer ^js event))]
             (reset! dragging* false)
             (when (pos? (.-length dropped))
               (dom/prevent-default event)
               (dom/stop-propagation event)
               (add-files dropped)))))

        on-remove
        (mf/use-fn #(st/emit! (chat/remove-attachment %)))]

    (mf/set-ref-val! pending-ref attachments)

    [:form {:class (stl/css-case :composer true
                                 :composer-dragging dragging)
            :on-submit on-submit
            :on-drag-over on-drag-over
            :on-drag-leave on-drag-leave
            :on-drop on-drop}
     [:ul {:class (stl/css :chips)}
      [:> selection-chip* {:chat chat}]
      (for [[index attachment] (map-indexed vector attachments)]
        [:> attachment-chip* {:key (str index "-" (chat/attachment-key attachment))
                              :attachment attachment
                              :on-remove on-remove}])]
     (when (seq problems)
       [:div {:class (stl/css :problems) :role "alert"}
        (for [[index problem] (map-indexed vector problems)]
          [:p {:key index :class (stl/css :problem)}
           (files/problem-text problem)])])
     [:textarea {:class (stl/css :input)
                 :value text
                 :rows 3
                 :disabled (or (not connected) locked)
                 :aria-label (tr "penforge.chat.input.label")
                 :placeholder (cond
                                locked   (tr "penforge.linked.reading")
                                dragging (tr "penforge.chat.attach.drop")
                                :else    (tr "penforge.chat.input.placeholder"))
                 :on-change on-change
                 :on-key-down on-key-down
                 :on-paste on-paste}]
     [:input {:type "file"
              :ref input-ref
              :multiple true
              :accept files/accept
              :class (stl/css :file-input)
              :tab-index -1
              :aria-hidden true
              :on-change on-input-change}]
     [:input {:type "file"
              :ref folder-ref
              ;; folder picker: the browser returns every file inside
              :webkitdirectory ""
              :multiple true
              :class (stl/css :file-input)
              :tab-index -1
              :aria-hidden true
              :on-change on-folder-change}]
     [:div {:class (stl/css :composer-actions)}
      [:div {:class (stl/css :attach-menu-wrapper)}
       [:> icon-button* {:variant "ghost"
                         :type "button"
                         :icon i/add
                         :disabled (or (not connected) locked)
                         :aria-label (tr "penforge.chat.attach.menu")
                         :aria-pressed menu-open
                         :on-click toggle-menu}]
       [:> dropdown-menu* {:show menu-open
                           :on-close close-menu
                           :class (stl/css :attach-menu)}
        [:> attach-menu-item* {:icon i/document
                               :label (tr "penforge.chat.attach.pick-file")
                               :on-click on-pick}]
        [:> attach-menu-item* {:icon i/folder
                               :label (tr "penforge.chat.attach.pick-folder")
                               :on-click on-pick-folder}]]]
      [:> button* {:variant "primary"
                   :type "submit"
                   :disabled (or (not connected) locked busy (empty? (.trim text)))}
       (tr "penforge.chat.input.send")]]]))

;; --- Panel

(mf/defc chat-panel*
  "The chat itself; rendered by the AI tab and by the detached window."
  []
  (let [chat       (mf/deref ref:chat)
        connection (mf/deref ref:connection)
        persona    (mf/deref ref:persona)
        locked     (mf/deref ref:locked)

        {:keys [entries status]} chat
        connected  (= :connected (:status connection))

        on-new-conversation
        (mf/use-fn #(st/emit! (chat/new-conversation)))]

    [:article {:class (stl/css :panel)
               :data-testid "ai-chat-panel"}
     [:header {:class (stl/css :panel-header)}
      [:span {:class (stl/css-case :status-dot true
                                   :status-connected connected)
              :title (if connected
                       (tr "penforge.chat.status.connected")
                       (tr "penforge.chat.status.disconnected"))}]
      [:> text* {:as "h2" :typography t/headline-small :class (stl/css :panel-title)}
       (tr "penforge.chat.title")]
      [:> icon-button* {:variant "ghost"
                        :icon i/add
                        :disabled (empty? entries)
                        :aria-label (tr "penforge.chat.new-conversation")
                        :on-click on-new-conversation}]
      [:> detach-button* {}]]

     [:> connection-banner* {:connection connection}]
     [:> design-system-start* {}]
     [:> linked-project-panel* {}]
     [:> design-system-binding* {}]

     (when (or connected (seq entries))
       [:> timeline* {:entries entries
                      :status status
                      :persona persona
                      :can-act (chat/can-act? chat connected)}])

     [:> work-status* {:chat chat}]

     [:> composer* {:chat chat
                    :status status
                    :connected connected
                    :locked locked}]]))

(mf/defc ai-chat-panel*
  "The AI tab: the chat, or a notice while it is in its own window."
  []
  (if (mf/deref ref:detached?)
    [:> detached-placeholder* {}]
    [:> chat-panel* {}]))
