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
   [app.main.refs :as refs]
   [app.main.render :as render]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :refer [icon*] :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.chat.banner :refer [connection-banner*]]
   [app.main.ui.workspace.ai.chat.markdown :refer [markdown*]]
   [app.main.ui.workspace.ai.detached.placeholder :refer [ref:detached? detach-button* detached-placeholder*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [app.util.shape-icon :as usi]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:chat
  (l/derived #(get-in % [:penforge :chat]) st/state))

(def ^:private ref:connection
  (l/derived #(get-in % [:penforge :connection]) st/state))

(def ^:private ref:persona
  (l/derived client/get-persona st/state))

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

(mf/defc attachment-chip*
  {::mf/private true}
  [{:keys [attachment on-remove]}]
  (let [{:keys [node-id name type]} attachment

        on-click
        (mf/use-fn
         (mf/deps node-id on-remove)
         #(on-remove node-id))]

    [:li {:class (stl/css :chip)}
     [:> node-thumbnail* {:node-id node-id :type type}]
     [:span {:class (stl/css :chip-name) :title name} name]
     (when on-remove
       [:> icon-button* {:variant "ghost"
                         :icon i/close-small
                         :icon-size "s"
                         :class (stl/css :chip-remove)
                         :aria-label (tr "penforge.chat.attachment.remove" name)
                         :on-click on-click}])]))

;; --- Timeline entries

(mf/defc user-entry*
  {::mf/private true}
  [{:keys [entry]}]
  (let [{:keys [text attachments]} entry]
    [:li {:class (stl/css :entry :entry-user)}
     (when (seq attachments)
       [:ul {:class (stl/css :chips)}
        (for [attachment attachments]
          [:> attachment-chip* {:key (:node-id attachment)
                                :attachment attachment}])])
     [:> text* {:as "p"
                :typography t/body-medium
                :class (stl/css :user-text)}
      text]]))

(mf/defc assistant-entry*
  {::mf/private true}
  [{:keys [entry]}]
  [:li {:class (stl/css :entry :entry-assistant)}
   [:> markdown* {:text (:text entry)}]
   (when (:streaming entry)
     [:span {:class (stl/css :caret) :aria-hidden true}])])

(mf/defc status-icon*
  {::mf/private true}
  [{:keys [status]}]
  (case status
    :done [:> icon* {:icon-id i/tick :size "s" :class (stl/css :tool-done)}]
    :error [:> icon* {:icon-id i/status-wrong :size "s" :class (stl/css :tool-error)}]
    [:span {:class (stl/css :spinner) :aria-hidden true}]))

(mf/defc tool-entry*
  {::mf/private true}
  [{:keys [entry persona]}]
  (let [{:keys [status summary tool-name detail]} entry
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
        [:span {:class (stl/css :tool-summary)} summary]])]))

(defn- get-error-text
  [{:keys [code message]}]
  (case code
    "not-connected" (tr "penforge.chat.error.not-connected")
    "busy" (tr "penforge.chat.error.busy")
    "no-context" (tr "penforge.chat.error.no-context")
    "not-configured" (tr "penforge.chat.error.not-configured")
    "not-implemented" (tr "penforge.chat.error.not-implemented")
    (or message (tr "penforge.chat.error.generic"))))

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

(mf/defc entry*
  {::mf/private true
   ::mf/memo true}
  [{:keys [entry persona]}]
  (case (:kind entry)
    :user       [:> user-entry* {:entry entry}]
    :assistant  [:> assistant-entry* {:entry entry}]
    :tool       [:> tool-entry* {:entry entry :persona persona}]
    :error      [:> error-entry* {:entry entry :persona persona}]
    :permission [:> permission-entry* {:entry entry}]
    :question   [:> question-entry* {:entry entry}]
    :workflow   [:> workflow-entry* {:entry entry :persona persona}]
    nil))

(mf/defc timeline*
  {::mf/private true}
  [{:keys [entries status persona]}]
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
       (for [entry entries]
         [:> entry* {:key (str (name (:kind entry)) "-" (:id entry))
                     :entry entry
                     :persona persona}])])))

;; --- Composer

(mf/defc composer*
  {::mf/private true}
  [{:keys [attachments status connected]}]
  (let [text*     (mf/use-state "")
        text      (deref text*)
        selected  (mf/deref refs/selected-shapes)
        streaming (= status :streaming)

        on-change
        (mf/use-fn #(reset! text* (dom/get-target-val %)))

        on-send
        (mf/use-fn
         (mf/deps text)
         (fn []
           (when (seq (.trim text))
             (st/emit! (chat/send-message text))
             (reset! text* ""))))

        on-submit
        (mf/use-fn
         (mf/deps on-send streaming)
         (fn [event]
           (dom/prevent-default event)
           (when-not streaming
             (on-send))))

        on-key-down
        (mf/use-fn
         (mf/deps on-send streaming)
         (fn [event]
           (when (and (kbd/enter? event)
                      (not (kbd/shift? event))
                      (not (.-isComposing ^js (.-nativeEvent event))))
             (dom/prevent-default event)
             (when-not streaming
               (on-send)))))

        on-cancel
        (mf/use-fn #(st/emit! (chat/cancel)))

        on-attach
        (mf/use-fn
         (mf/deps selected)
         #(st/emit! (chat/attach-node selected)))

        on-remove
        (mf/use-fn #(st/emit! (chat/remove-attachment %)))]

    [:form {:class (stl/css :composer)
            :on-submit on-submit}
     (when (seq attachments)
       [:ul {:class (stl/css :chips)}
        (for [attachment attachments]
          [:> attachment-chip* {:key (:node-id attachment)
                                :attachment attachment
                                :on-remove on-remove}])])
     [:textarea {:class (stl/css :input)
                 :value text
                 :rows 3
                 :disabled (not connected)
                 :aria-label (tr "penforge.chat.input.label")
                 :placeholder (tr "penforge.chat.input.placeholder")
                 :on-change on-change
                 :on-key-down on-key-down}]
     [:div {:class (stl/css :composer-actions)}
      [:> icon-button* {:variant "ghost"
                        :icon i/add
                        :disabled (or (not connected) (empty? selected))
                        :aria-label (tr "penforge.chat.input.attach-selection")
                        :on-click on-attach}]
      (if streaming
        [:> button* {:variant "secondary"
                     :type "button"
                     :on-click on-cancel}
         (tr "penforge.chat.input.stop")]
        [:> button* {:variant "primary"
                     :type "submit"
                     :disabled (or (not connected) (empty? (.trim text)))}
         (tr "penforge.chat.input.send")])]]))

;; --- Panel

(mf/defc chat-panel*
  "The chat itself; rendered by the AI tab and by the detached window."
  []
  (let [chat       (mf/deref ref:chat)
        connection (mf/deref ref:connection)
        persona    (mf/deref ref:persona)

        {:keys [entries status attachments]} chat
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

     (when (or connected (seq entries))
       [:> timeline* {:entries entries
                      :status status
                      :persona persona}])

     [:> composer* {:attachments attachments
                    :status status
                    :connected connected}]]))

(mf/defc ai-chat-panel*
  "The AI tab: the chat, or a notice while it is in its own window."
  []
  (if (mf/deref ref:detached?)
    [:> detached-placeholder* {}]
    [:> chat-panel* {}]))
