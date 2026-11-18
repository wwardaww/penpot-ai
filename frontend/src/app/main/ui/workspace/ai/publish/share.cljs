;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.publish.share
  "Share panel (W20): download the app's code, send it to GitHub, put
  it online with Vercel or Netlify, open it on a phone, and the
  Accounts tab where the provider tokens are connected. Every step
  that sends the app somewhere asks first in the panel."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.publish :as dap]
   [app.main.data.ai.client :as client]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:publish
  (l/derived #(get-in % dap/state-path dap/empty-state) st/state))

(def ^:private ref:persona
  (l/derived client/get-persona st/state))

(def ^:private ref:connected
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(def token-pages
  "Pages where the user creates a token, with the smallest scopes."
  {:github "https://github.com/settings/tokens/new?scopes=repo&description=Penforge"
   :vercel "https://vercel.com/account/settings/tokens"
   :netlify "https://app.netlify.com/user/applications#personal-access-tokens"})

(defn provider-name
  [provider]
  (case provider
    :github  "GitHub"
    :vercel  "Vercel"
    :netlify "Netlify"
    (str provider)))

(defn step-text
  "Translated progress step of a publish run."
  [{:keys [step text]}]
  (case step
    "save"    (tr "penforge.publish.step.save")
    "repo"    (tr "penforge.publish.step.repo")
    "push"    (tr "penforge.publish.step.push")
    "install" (tr "penforge.publish.step.install")
    "build"   (tr "penforge.publish.step.build")
    "upload"  (tr "penforge.publish.step.upload")
    "deploy"  (tr "penforge.publish.step.deploy")
    "phone"   (tr "penforge.publish.step.phone")
    (or text (tr "penforge.publish.working"))))

(defn qr-path
  "SVG path drawing the dark modules of a QR matrix (rows of 0/1)."
  [rows]
  (->> rows
       (map-indexed
        (fn [y row]
          (->> row
               (map-indexed (fn [x module]
                              (when (= module \1)
                                (str "M" x " " y "h1v1h-1z"))))
               (apply str))))
       (apply str)))

;; --- Building blocks

(mf/defc qr-code*
  [{:keys [qr label]}]
  (let [size  (:size qr)
        quiet 4
        path  (mf/with-memo [qr] (qr-path (:rows qr)))]
    [:svg {:class (stl/css :qr)
           :role "img"
           :aria-label label
           :view-box (str (- quiet) " " (- quiet) " " (+ size (* 2 quiet)) " " (+ size (* 2 quiet)))
           :shape-rendering "crispEdges"}
     [:rect {:x (- quiet) :y (- quiet) :width (+ size (* 2 quiet)) :height (+ size (* 2 quiet)) :fill "#ffffff"}]
     [:path {:d path :fill "#000000"}]]))

(mf/defc problem*
  {::mf/private true}
  [{:keys [error developer action]}]
  (let [on-dismiss (mf/use-fn (mf/deps action) #(st/emit! (dap/clear-error action)))]
    [:div {:class (stl/css :problem) :role "alert"}
     [:> text* {:as "p" :typography t/body-small :class (stl/css :problem-text)}
      (dap/error-text error)]
     (when (and developer (not (str/blank? (:detail error))))
       [:pre {:class (stl/css :detail)} (:detail error)])
     [:> icon-button* {:variant "ghost"
                       :icon i/close-small
                       :aria-label (tr "labels.close")
                       :on-click on-dismiss}]]))

(mf/defc link*
  {::mf/private true}
  [{:keys [href label]}]
  [:a {:class (stl/css :link) :href href :target "_blank" :rel "noopener noreferrer"}
   (or label href)])

(mf/defc section*
  {::mf/private true}
  [{:keys [title description highlighted children]}]
  [:section {:class (stl/css-case :section true :highlighted highlighted)}
   [:> text* {:as "h3" :typography t/body-large :class (stl/css :section-title)} title]
   (when description
     [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)} description])
   children])

(mf/defc confirm*
  "Inline question with a primary and a cancel button."
  {::mf/private true}
  [{:keys [message accept-label on-accept on-cancel]}]
  [:div {:class (stl/css :confirm)}
   [:> text* {:as "p" :typography t/body-small :class (stl/css :confirm-text)} message]
   [:div {:class (stl/css :buttons)}
    [:> button* {:variant "primary" :on-click on-accept} accept-label]
    [:> button* {:variant "secondary" :on-click on-cancel} (tr "penforge.publish.cancel")]]])

(mf/defc running*
  {::mf/private true}
  [{:keys [progress]}]
  [:> text* {:as "p" :typography t/body-small :class (stl/css :running) :aria-live "polite"}
   (step-text progress)])

(mf/defc not-connected*
  {::mf/private true}
  [{:keys [provider]}]
  (let [on-click (mf/use-fn #(st/emit! (dap/select-tab :accounts)))]
    [:div {:class (stl/css :row)}
     [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
      (tr "penforge.publish.needs-account" (provider-name provider))]
     [:> button* {:variant "secondary" :on-click on-click}
      (tr "penforge.publish.connect-account")]]))

;; --- Sections

(mf/defc zip-section*
  [{:keys [publish developer connected]}]
  (let [busy     (dap/busy? publish :zip)
        error    (get-in publish [:errors :zip])
        on-click (mf/use-fn #(st/emit! (dap/download-zip)))]
    [:> section* {:title (tr "penforge.publish.zip.title")
                  :description (if developer
                                 (tr "penforge.publish.zip.description.developer")
                                 (tr "penforge.publish.zip.description"))
                  :highlighted (= :zip (:target publish))}
     [:div {:class (stl/css :buttons)}
      [:> button* {:variant "secondary"
                   :icon i/download
                   :disabled (or busy (not connected))
                   :on-click on-click}
       (if busy (tr "penforge.publish.zip.preparing") (tr "penforge.publish.zip.action"))]]
     (when error
       [:> problem* {:error error :developer developer :action :zip}])]))

(mf/defc github-section*
  [{:keys [publish developer connected]}]
  (let [account   (dap/connected-account publish :github)
        published (get-in publish [:published :github])
        busy      (dap/busy? publish :github)
        error     (get-in publish [:errors :github])
        result    (get-in publish [:results :github])
        step*     (mf/use-state nil)
        step      (deref step*)
        name*     (mf/use-state nil)
        private*  (mf/use-state true)
        repo-name (or (deref name*) (:repo published) "")
        private?  (if published (:private published) (deref private*))
        public?   (not private?)
        target    (if (str/blank? repo-name)
                    (:login account)
                    (str (:login account) "/" repo-name))

        on-name   (fn [event] (reset! name* (dom/get-target-val event)))
        on-private (fn [_] (swap! private* not))
        on-start  (fn [] (reset! step* :confirm))
        on-cancel (fn [] (reset! step* nil))
        on-accept (fn []
                    (if (and public? (nil? published) (not= step :confirm-public))
                      (reset! step* :confirm-public)
                      (do (reset! step* nil)
                          (st/emit! (dap/publish-github {:name repo-name :private? private?})))))]
    [:> section* {:title (if developer
                           (tr "penforge.publish.github.title.developer")
                           (tr "penforge.publish.github.title"))
                  :description (if developer
                                 (tr "penforge.publish.github.description.developer")
                                 (tr "penforge.publish.github.description"))
                  :highlighted (= :github (:target publish))}
     (cond
       (nil? account)
       [:> not-connected* {:provider :github}]

       busy
       [:> running* {:progress (get-in publish [:progress :github])}]

       (= step :confirm)
       [:> confirm* {:message (tr "penforge.publish.github.confirm" target)
                     :accept-label (tr "penforge.publish.github.action")
                     :on-accept on-accept
                     :on-cancel on-cancel}]

       (= step :confirm-public)
       [:> confirm* {:message (tr "penforge.publish.github.confirm-public" target)
                     :accept-label (tr "penforge.publish.github.make-public")
                     :on-accept on-accept
                     :on-cancel on-cancel}]

       :else
       [:div {:class (stl/css :form)}
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.publish.connected-as" (:login account))]
        (if published
          [:> text* {:as "p" :typography t/body-small}
           (tr "penforge.publish.github.repo" (str (:owner published) "/" (:repo published)))]
          [:*
           [:> input* {:label (tr "penforge.publish.github.name")
                       :placeholder (tr "penforge.publish.github.name-placeholder")
                       :default-value repo-name
                       :max-length 100
                       :on-change on-name}]
           [:> checkbox* {:id "penforge-publish-private"
                          :label (tr "penforge.publish.github.private")
                          :checked private?
                          :on-change on-private}]])
        [:div {:class (stl/css :buttons)}
         [:> button* {:variant "primary" :disabled (not connected) :on-click on-start}
          (if published
            (tr "penforge.publish.github.update")
            (tr "penforge.publish.github.action"))]]])
     (when (and result (not busy) (:url result))
       [:> text* {:as "p" :typography t/body-small}
        (tr "penforge.publish.github.done") " " [:> link* {:href (:url result)}]])
     (when (and published (not result) (not busy))
       [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
        [:> link* {:href (:url published)}]])
     (when error
       [:> problem* {:error error :developer developer :action :github}])]))

(mf/defc site-section*
  [{:keys [publish developer connected provider]}]
  (let [account   (dap/connected-account publish provider)
        published (get-in publish [:published provider])
        busy      (dap/busy? publish provider)
        error     (get-in publish [:errors provider])
        result    (get-in publish [:results provider])
        url       (or (:url result) (:url published))
        asking*   (mf/use-state false)
        label     (provider-name provider)
        on-start  (fn [] (reset! asking* true))
        on-cancel (fn [] (reset! asking* false))
        on-accept (fn []
                    (reset! asking* false)
                    (st/emit! (dap/deploy provider)))]
    [:> section* {:title (tr "penforge.publish.site.title" label)
                  :description (if developer
                                 (tr "penforge.publish.site.description.developer" label)
                                 (tr "penforge.publish.site.description" label))
                  :highlighted (= provider (:target publish))}
     (cond
       (nil? account)
       [:> not-connected* {:provider provider}]

       busy
       [:> running* {:progress (get-in publish [:progress provider])}]

       (deref asking*)
       [:> confirm* {:message (tr "penforge.publish.site.confirm" label)
                     :accept-label (tr "penforge.publish.site.action")
                     :on-accept on-accept
                     :on-cancel on-cancel}]

       :else
       [:div {:class (stl/css :form)}
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.publish.connected-as" (:login account))]
        [:div {:class (stl/css :buttons)}
         [:> button* {:variant "primary" :disabled (not connected) :on-click on-start}
          (if published
            (tr "penforge.publish.site.update")
            (tr "penforge.publish.site.action"))]]])
     (when (and url (not busy))
       [:> text* {:as "p" :typography t/body-small}
        (tr "penforge.publish.site.live") " " [:> link* {:href url}]])
     (when error
       [:> problem* {:error error :developer developer :action provider}])]))

(mf/defc phone-section*
  [{:keys [publish developer connected]}]
  (let [phone     (:phone publish)
        busy      (dap/busy? publish :phone)
        error     (get-in publish [:errors :phone])
        asking*   (mf/use-state false)
        on-start  (fn [] (reset! asking* true))
        on-cancel (fn [] (reset! asking* false))
        on-accept (fn []
                    (reset! asking* false)
                    (st/emit! (dap/start-phone)))
        on-stop   (mf/use-fn #(st/emit! (dap/stop-phone)))]
    [:> section* {:title (tr "penforge.publish.phone.title")
                  :description (tr "penforge.publish.phone.description")
                  :highlighted (= :phone (:target publish))}
     (cond
       (= "ready" (:state phone))
       [:div {:class (stl/css :phone)}
        [:> qr-code* {:qr (:qr phone) :label (tr "penforge.publish.phone.qr-label")}]
        [:div {:class (stl/css :phone-info)}
         [:> text* {:as "p" :typography t/body-small}
          (tr "penforge.publish.phone.scan")]
         [:> text* {:as "p" :typography t/body-small :class (stl/css :warning)}
          (tr "penforge.publish.phone.lan-open")]
         (when developer
           [:code {:class (stl/css :code)} (:url phone)])
         [:div {:class (stl/css :buttons)}
          [:> button* {:variant "secondary" :on-click on-stop}
           (tr "penforge.publish.phone.stop")]]]]

       busy
       [:> running* {:progress (or (get-in publish [:progress :phone]) {:step "phone"})}]

       (deref asking*)
       [:> confirm* {:message (tr "penforge.publish.phone.confirm")
                     :accept-label (tr "penforge.publish.phone.action")
                     :on-accept on-accept
                     :on-cancel on-cancel}]

       :else
       [:div {:class (stl/css :buttons)}
        [:> button* {:variant "primary" :disabled (not connected) :on-click on-start}
         (tr "penforge.publish.phone.action")]])
     (when error
       [:> problem* {:error error :developer developer :action :phone}])]))

;; --- Accounts

(mf/defc account-row*
  {::mf/private true}
  [{:keys [provider account busy connecting error developer connected]}]
  (let [input-ref     (mf/use-ref nil)
        label         (provider-name provider)
        on-connect    (mf/use-fn
                       (mf/deps provider)
                       (fn []
                         (when-let [node (mf/ref-val input-ref)]
                           (let [token (str/trim (.-value ^js node))]
                             ;; the field is emptied at once; the token goes to the daemon only
                             (set! (.-value ^js node) "")
                             (when-not (str/blank? token)
                               (st/emit! (dap/connect-account provider token)))))))
        on-key-down   (mf/use-fn
                       (mf/deps on-connect)
                       (fn [event]
                         (when (= "Enter" (.-key ^js event))
                           (on-connect))))
        on-disconnect (mf/use-fn
                       (mf/deps provider)
                       #(st/emit! (dap/disconnect-account provider)))]
    [:div {:class (stl/css :account)}
     [:> text* {:as "h3" :typography t/body-large :class (stl/css :section-title)} label]
     (if account
       [:div {:class (stl/css :row)}
        [:> text* {:as "p" :typography t/body-small}
         (tr "penforge.publish.connected-as" (:login account))]
        [:> button* {:variant "secondary" :disabled (or busy (not connected)) :on-click on-disconnect}
         (tr "penforge.publish.accounts.disconnect")]]
       [:div {:class (stl/css :form)}
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (case provider
           :github  (tr "penforge.publish.accounts.help.github")
           :vercel  (tr "penforge.publish.accounts.help.vercel")
           (tr "penforge.publish.accounts.help.netlify"))
         " "
         [:> link* {:href (get token-pages provider) :label (tr "penforge.publish.accounts.create-token")}]]
        [:div {:class (stl/css :row)}
         [:> input* {:ref input-ref
                     :type "password"
                     :aria-label (tr "penforge.publish.accounts.token-label" label)
                     :placeholder (tr "penforge.publish.accounts.token-placeholder")
                     :auto-complete "off"
                     :spell-check false
                     :disabled (or busy (not connected))
                     :on-key-down on-key-down}]
         [:> button* {:variant "primary" :disabled (or busy (not connected)) :on-click on-connect}
          (if (and busy connecting)
            (tr "penforge.publish.accounts.checking")
            (tr "penforge.publish.accounts.connect"))]]])
     (when error
       [:> problem* {:error error :developer developer :action :connect}])]))

(mf/defc accounts-panel*
  [{:keys [publish developer connected]}]
  (let [connecting (:connecting publish)
        busy       (or (dap/busy? publish :connect) (dap/busy? publish :disconnect))]
    [:div {:class (stl/css :sections)}
     [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
      (tr "penforge.publish.accounts.intro")]
     (for [provider dap/providers]
       [:> account-row* {:key (name provider)
                         :provider provider
                         :account (dap/connected-account publish provider)
                         :busy busy
                         :connecting (= connecting provider)
                         :error (when (= connecting provider) (get-in publish [:errors :connect]))
                         :developer developer
                         :connected connected}])]))

;; --- Dialog

(mf/defc share-dialog*
  {::mf/register modal/components
   ::mf/register-as :penforge-share}
  []
  (let [publish   (mf/deref ref:publish)
        persona   (mf/deref ref:persona)
        connected (mf/deref ref:connected)
        developer (= persona :developer)
        tab       (:tab publish)
        app       (:app publish)
        loading   (= :loading (:status publish))

        on-close    (mf/use-fn #(st/emit! (dap/close-share)))
        on-share    (mf/use-fn #(st/emit! (dap/select-tab :share)))
        on-accounts (mf/use-fn #(st/emit! (dap/select-tab :accounts)))
        props       {:publish publish :developer developer :connected connected}]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-dialog)
            :role "dialog"
            :aria-labelledby "ai-share-title"
            :data-testid "ai-share-dialog"}
      [:> icon-button* {:variant "ghost"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click on-close}]
      [:> text* {:as "h2" :id "ai-share-title"
                 :typography t/headline-medium :class (stl/css :modal-title)}
       (tr "penforge.publish.title")]

      [:div {:class (stl/css :tabs) :role "tablist"}
       [:button {:class (stl/css-case :tab true :tab-active (= tab :share))
                 :role "tab"
                 :aria-selected (= tab :share)
                 :on-click on-share}
        (tr "penforge.publish.tab.share")]
       [:button {:class (stl/css-case :tab true :tab-active (= tab :accounts))
                 :role "tab"
                 :aria-selected (= tab :accounts)
                 :on-click on-accounts}
        (tr "penforge.publish.tab.accounts")]]

      [:div {:class (stl/css :modal-content)}
       (cond
         (not connected)
         [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
          (tr "penforge.publish.error.daemon")]

         (= tab :accounts)
         [:> accounts-panel* props]

         (and (not loading) (= :loaded (:status publish)) (not (:exists app)))
         [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
          (tr "penforge.publish.no-app")]

         :else
         [:div {:class (stl/css :sections)}
          [:> zip-section* props]
          [:> github-section* props]
          [:> site-section* (assoc props :provider :vercel)]
          [:> site-section* (assoc props :provider :netlify)]
          (when (:phone app)
            [:> phone-section* props])])]]]))
