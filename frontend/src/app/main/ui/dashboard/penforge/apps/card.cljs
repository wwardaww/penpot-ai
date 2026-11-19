;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.apps.card
  "Card of one built app on the dashboard (W33): thumbnail, name,
  platform, stack, last build, run state and the actions Open, Stop,
  Open design, Open on phone (Expo), and for developers Logs and the
  app folder."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.main.data.ai.apps :as apps]
   [app.main.data.common :as dcm]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.clipboard :as clipboard]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

;; --- Texts

(defn- reason-text
  [reason]
  (case reason
    "start-timeout"  (tr "penforge.preview.reason.start-timeout")
    "crashed"        (tr "penforge.preview.reason.crashed")
    "command-failed" (tr "penforge.preview.reason.command-failed")
    "project-closed" (tr "penforge.preview.reason.project-closed")
    "daemon-stopped" (tr "penforge.preview.reason.daemon-stopped")
    "exposed"        (tr "penforge.preview.reason.exposed")
    nil))

(defn- state-text
  [state]
  (case state
    "starting" (tr "penforge.apps.state.starting")
    "ready"    (tr "penforge.apps.state.running")
    "failed"   (tr "penforge.apps.state.failed")
    (tr "penforge.apps.state.stopped")))

(defn- error-text
  [{:keys [code]}]
  (case code
    "not-connected"  (tr "penforge.apps.error.not-connected")
    "not-configured" (tr "penforge.apps.error.not-built")
    (tr "penforge.apps.error.other")))

(defn- phone-error-text
  [code]
  (case code
    "no-phone-preview" (tr "penforge.publish.error.no-phone-preview")
    "no-network"       (tr "penforge.publish.error.no-network")
    "preview-failed"   (tr "penforge.publish.error.preview-failed")
    "no-app"           (tr "penforge.publish.error.no-app")
    "busy"             (tr "penforge.publish.error.busy")
    (tr "penforge.publish.error.other")))

;; --- Phone (Expo)

(defn qr-path
  "SVG path of the dark modules of a QR matrix (rows of 0/1)."
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

(mf/defc qr-code*
  {::mf/private true}
  [{:keys [qr label]}]
  (let [size  (:size qr)
        quiet 4
        side  (+ size (* 2 quiet))
        path  (mf/with-memo [qr] (qr-path (:rows qr)))]
    [:svg {:class (stl/css :qr)
           :role "img"
           :aria-label label
           :view-box (str (- quiet) " " (- quiet) " " side " " side)
           :shape-rendering "crispEdges"}
     [:rect {:x (- quiet) :y (- quiet) :width side :height side :fill "#ffffff"}]
     [:path {:d path :fill "#000000"}]]))

(mf/defc phone-panel*
  "Consent, then the QR code of the phone session; closing the panel
  ends the session."
  {::mf/private true}
  [{:keys [project-id phone developer on-close]}]
  (let [state (:state phone)

        on-accept
        (mf/use-fn
         (mf/deps project-id)
         #(st/emit! (apps/start-phone project-id)))

        on-stop
        (mf/use-fn
         (mf/deps project-id)
         #(st/emit! (apps/stop-phone project-id)))

        on-dismiss
        (mf/use-fn
         (mf/deps project-id on-close)
         (fn []
           (st/emit! (apps/close-phone project-id))
           (on-close)))]

    [:section {:class (stl/css :panel)
               :aria-label (tr "penforge.publish.phone.title")}
     (cond
       (= state "ready")
       [:div {:class (stl/css :phone)}
        [:> qr-code* {:qr (:qr phone) :label (tr "penforge.publish.phone.qr-label")}]
        [:div {:class (stl/css :phone-info)}
         [:> text* {:as "p" :typography t/body-small}
          (tr "penforge.publish.phone.scan")]
         [:> text* {:as "p" :typography t/body-small :class (stl/css :warning)}
          (tr "penforge.publish.phone.lan-open")]
         (when ^boolean developer
           [:code {:class (stl/css :code)} (:url phone)])
         [:> button* {:variant "secondary" :on-click on-stop}
          (tr "penforge.publish.phone.stop")]]]

       (= state "starting")
       [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
        (tr "penforge.publish.step.phone")]

       (= state "failed")
       [:div {:class (stl/css :panel-row)}
        [:> text* {:as "p" :typography t/body-small :class (stl/css :error)}
         (phone-error-text (:code phone))]
        [:> button* {:variant "ghost" :on-click on-dismiss}
         (tr "penforge.apps.action.close")]]

       (= state "stopped")
       [:div {:class (stl/css :panel-row)}
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.apps.phone.stopped")]
        [:> button* {:variant "ghost" :on-click on-dismiss}
         (tr "penforge.apps.action.close")]]

       :else
       [:div {:class (stl/css :consent)}
        [:> text* {:as "p" :typography t/body-small}
         (tr "penforge.publish.phone.description")]
        [:> text* {:as "p" :typography t/body-small :class (stl/css :warning)}
         (tr "penforge.publish.phone.confirm")]
        [:div {:class (stl/css :panel-row)}
         [:> button* {:variant "primary" :on-click on-accept}
          (tr "penforge.publish.phone.action")]
         [:> button* {:variant "ghost" :on-click on-dismiss}
          (tr "penforge.apps.action.cancel")]]])]))

;; --- Developer panels

(mf/defc logs-panel*
  {::mf/private true}
  [{:keys [project-id logs]}]
  (let [on-refresh (mf/use-fn (mf/deps project-id) #(st/emit! (apps/fetch-logs project-id)))
        on-close   (mf/use-fn (mf/deps project-id) #(st/emit! (apps/close-logs project-id)))
        lines      (:lines logs)]
    [:section {:class (stl/css :panel) :aria-label (tr "penforge.apps.action.logs")}
     (if (seq lines)
       [:pre {:class (stl/css :logs)}
        (for [[index {:keys [stream text]}] (map-indexed vector lines)]
          [:span {:key index :class (stl/css-case :log-line true :log-error (= stream "stderr"))}
           text "\n"])]
       [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
        (if (:loading logs)
          (tr "penforge.apps.logs.loading")
          (tr "penforge.apps.logs.empty"))])
     [:div {:class (stl/css :panel-row)}
      [:> button* {:variant "ghost" :icon i/reload :on-click on-refresh}
       (tr "penforge.apps.logs.refresh")]
      [:> button* {:variant "ghost" :on-click on-close}
       (tr "penforge.apps.action.close")]]]))

(mf/defc folder-panel*
  {::mf/private true}
  [{:keys [path on-close]}]
  (let [copied*  (mf/use-state false)
        on-copy  (mf/use-fn
                  (mf/deps path)
                  (fn []
                    (-> (clipboard/to-clipboard path)
                        (.then #(reset! copied* true))
                        (.catch (fn [_] nil)))))]
    [:section {:class (stl/css :panel) :aria-label (tr "penforge.apps.action.folder")}
     [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
      (tr "penforge.apps.folder.hint")]
     [:code {:class (stl/css :code)} path]
     [:div {:class (stl/css :panel-row)}
      [:> button* {:variant "ghost" :icon i/clipboard :on-click on-copy}
       (if (deref copied*) (tr "penforge.apps.folder.copied") (tr "penforge.apps.folder.copy"))]
      [:> button* {:variant "ghost" :on-click on-close}
       (tr "penforge.apps.action.close")]]]))

;; --- Card

(mf/defc app-card*
  [{:keys [app developer pending error logs phone connected]}]
  (let [{:keys [project-id name team-id file-id platform stack expo web
                built-at thumbnail status app-path]} app

        state      (:state status)
        live       (apps/live? app)
        url        (apps/ready-url app)
        starting   (or ^boolean pending (= state "starting"))
        phone-open* (mf/use-state false)
        folder*    (mf/use-state false)
        mobile     (= platform "mobile")

        on-open
        (mf/use-fn
         (mf/deps project-id url web expo)
         (fn [event]
           (dom/stop-propagation event)
           (cond
             (some? url)
             (dom/open-new-window url)

             ^boolean web
             (st/emit! (apps/start-app project-id (apps/open-waiting-tab!)))

             ;; Expo app without web: it opens on a phone only
             ^boolean expo
             (reset! phone-open* true))))

        on-stop
        (mf/use-fn
         (mf/deps project-id)
         (fn [event]
           (dom/stop-propagation event)
           (st/emit! (apps/stop-app project-id))))

        on-design
        (mf/use-fn
         (mf/deps team-id file-id)
         (fn [event]
           (dom/stop-propagation event)
           (when-let [file-id (uuid/parse* file-id)]
             (st/emit! (dcm/go-to-workspace :team-id (uuid/parse* team-id)
                                            :file-id file-id)))))

        on-phone
        (mf/use-fn #(reset! phone-open* true))

        on-close-phone
        (mf/use-fn
         (mf/deps project-id phone)
         (fn []
           (when (contains? #{"starting" "ready"} (:state phone))
             (st/emit! (apps/stop-phone project-id)))
           (reset! phone-open* false)))

        on-logs
        (mf/use-fn
         (mf/deps project-id logs)
         #(st/emit! (if logs (apps/close-logs project-id) (apps/fetch-logs project-id))))

        on-folder
        (mf/use-fn #(swap! folder* not))
        on-close-folder
        (mf/use-fn #(reset! folder* false))

        built
        (mf/with-memo [built-at]
          (some-> built-at ct/inst ct/timeago))]

    [:article {:class (stl/css :card)
               :data-testid "penforge-app-card"
               :aria-label name}
     [:div {:class (stl/css-case :thumbnail true :thumbnail-mobile mobile)}
      (if (string? thumbnail)
        [:img {:src thumbnail :alt "" :class (stl/css :thumbnail-img)}]
        [:> icon* {:icon-id i/board :size "l" :class (stl/css :thumbnail-icon)}])]

     [:div {:class (stl/css :body)}
      [:div {:class (stl/css :title-row)}
       [:> text* {:as "h2" :typography t/body-large :class (stl/css :name)} name]
       [:span {:class (stl/css-case :state true
                                    :state-ready (= state "ready")
                                    :state-starting starting
                                    :state-failed (= state "failed"))}
        (if starting (state-text "starting") (state-text state))]]

      [:div {:class (stl/css :meta)}
       [:span {:class (stl/css-case :badge true :badge-mobile mobile)}
        (if mobile (tr "penforge.platform.mobile") (tr "penforge.platform.web"))]
       [:> text* {:as "span" :typography t/body-small :class (stl/css :muted)}
        (:name stack)]
       (when built
         [:> text* {:as "span" :typography t/body-small :class (stl/css :muted)}
          (tr "penforge.apps.built" built)])]

      (when (= state "failed")
        (when-let [text (reason-text (:reason status))]
          [:> text* {:as "p" :typography t/body-small :class (stl/css :error)} text]))
      (when (some? error)
        [:> text* {:as "p" :typography t/body-small :class (stl/css :error)}
         (error-text error)])
      (when (and (= state "ready") (= "lan" (:exposure status)))
        [:> text* {:as "p" :typography t/body-small :class (stl/css :warning)}
         (tr "penforge.publish.phone.lan-open")])
      (when (and ^boolean expo (not ^boolean web) (not (deref phone-open*)))
        [:> text* {:as "p" :typography t/body-small :class (stl/css :muted)}
         (tr "penforge.apps.mobile-hint")])

      [:div {:class (stl/css :actions)}
       (when (or ^boolean web (not ^boolean expo))
         [:> button* {:variant "primary"
                      :icon i/play
                      :disabled (or (not connected) starting)
                      :on-click on-open}
          (if starting (tr "penforge.apps.state.starting") (tr "penforge.apps.action.open"))])
       (when ^boolean expo
         [:> button* {:variant (if ^boolean web "secondary" "primary")
                      :disabled (not connected)
                      :on-click on-phone}
          (tr "penforge.publish.phone.title")])
       (when live
         [:> button* {:variant "secondary" :disabled (not connected) :on-click on-stop}
          (tr "penforge.apps.action.stop")])
       (when (some? file-id)
         [:> button* {:variant "ghost" :icon i/open-link :on-click on-design}
          (tr "penforge.apps.action.design")])
       (when ^boolean developer
         [:> button* {:variant "ghost" :icon i/code :disabled (not connected) :on-click on-logs}
          (tr "penforge.apps.action.logs")])
       (when ^boolean developer
         [:> button* {:variant "ghost" :icon i/folder :on-click on-folder}
          (tr "penforge.apps.action.folder")])]

      (when (or (deref phone-open*) (some? phone))
        [:> phone-panel* {:project-id project-id
                          :phone phone
                          :developer developer
                          :on-close on-close-phone}])
      (when (and ^boolean developer (some? logs))
        [:> logs-panel* {:project-id project-id :logs logs}])
      (when (and ^boolean developer (deref folder*))
        [:> folder-panel* {:path app-path :on-close on-close-folder}])]]))
