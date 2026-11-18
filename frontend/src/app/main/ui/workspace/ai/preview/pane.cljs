;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.preview.pane
  "Live preview of the generated app: a resizable pane next to the
  canvas (`:split`) or a large overlay (`:overlay`)."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.preview :as preview]
   [app.main.data.penforge :as penforge]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [goog.events :as events]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def preview-ref
  (l/derived #(get-in % [:penforge :preview]) st/state))

(def split-open-ref
  "True while the preview is shown as a pane next to the canvas."
  (l/derived #(= :split (get-in % [:penforge :preview :pane])) st/state))

(def connected-ref
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

(def developer-ref
  (l/derived #(= :developer (penforge/current-persona %)) st/state))

(def ^:private frame-sandbox
  "The app runs on another origin (its own port), so `allow-same-origin`
  only gives it its own storage."
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads")

(defn- max-split-width
  []
  (* 0.7 (or (some-> js/window .-innerWidth) 1440)))

(defn- status-label
  [{:keys [status restarts reason]}]
  (cond
    (and (= status :starting)
         (or (= reason :restarting) (pos? (or restarts 0))))
    (tr "penforge.preview.status.restarting")

    (= status :starting) (tr "penforge.preview.status.starting")
    (= status :ready)    (tr "penforge.preview.status.ready")
    (= status :stopped)  (tr "penforge.preview.status.stopped")
    (= status :failed)   (tr "penforge.preview.status.failed")
    :else                (tr "penforge.preview.status.idle")))

(defn problem-text
  "Plain-language text of a failed or stopped preview, from the daemon
  reason or request error code (the daemon sends codes, not copy)."
  [{:keys [status reason code]}]
  (cond
    (= reason :start-timeout)  (tr "penforge.preview.reason.start-timeout")
    (= reason :crashed)        (tr "penforge.preview.reason.crashed")
    (= reason :command-failed) (tr "penforge.preview.reason.command-failed")
    (= reason :project-closed) (tr "penforge.preview.reason.project-closed")
    (= reason :daemon-stopped) (tr "penforge.preview.reason.daemon-stopped")
    (= reason :exposed)        (tr "penforge.preview.reason.exposed")
    (= code "bad-request")     (tr "penforge.preview.reason.invalid-setup")
    (= status :failed)         (tr "penforge.preview.status.failed")
    :else                      (tr "penforge.preview.stopped-hint")))

(mf/defc device-switch*
  {::mf/private true}
  [{:keys [device]}]
  (let [on-desktop (mf/use-fn #(st/emit! (preview/set-device :desktop)))
        on-mobile  (mf/use-fn #(st/emit! (preview/set-device :mobile)))]
    [:div {:class (stl/css :device-switch)
           :role "group"
           :aria-label (tr "penforge.preview.device")}
     [:button {:class (stl/css-case :device-option true
                                    :device-selected (= device :desktop))
               :aria-pressed (= device :desktop)
               :on-click on-desktop}
      (tr "penforge.preview.device.desktop")]
     [:button {:class (stl/css-case :device-option true
                                    :device-selected (= device :mobile))
               :aria-pressed (= device :mobile)
               :on-click on-mobile}
      (tr "penforge.preview.device.mobile")]]))

(mf/defc toolbar*
  {::mf/private true}
  [{:keys [preview]}]
  (let [{:keys [status url pane device]} preview
        ready?     (= status :ready)
        live?      (preview/live? preview)

        on-reload  (mf/use-fn #(st/emit! (preview/reload)))
        on-close   (mf/use-fn #(st/emit! (preview/close-pane)))
        on-stop    (mf/use-fn #(st/emit! (preview/stop-preview)))
        on-start   (mf/use-fn #(st/emit! (preview/start-preview)))
        on-mode    (mf/use-fn
                    (mf/deps pane)
                    #(st/emit! (preview/open-pane (if (= pane :overlay) :split :overlay))))
        on-open    (mf/use-fn
                    (mf/deps url)
                    #(when url (dom/open-new-window url)))]
    [:header {:class (stl/css :toolbar)}
     [:span {:class (stl/css-case :status-dot true
                                  :status-ready ready?
                                  :status-starting (= status :starting)
                                  :status-failed (= status :failed))
             :aria-hidden true}]
     [:div {:class (stl/css :title)}
      [:> text* {:as "h2" :typography t/headline-small :class (stl/css :title-text)}
       (tr "penforge.preview.title")]
      [:> text* {:as "span" :typography t/body-small :class (stl/css :muted)}
       (status-label preview)]]

     [:> device-switch* {:device device}]

     [:> icon-button* {:variant "ghost"
                       :aria-label (tr "penforge.preview.reload")
                       :icon i/reload
                       :disabled (not ready?)
                       :on-click on-reload}]
     [:> icon-button* {:variant "ghost"
                       :aria-label (tr "penforge.preview.open-tab")
                       :icon i/open-link
                       :disabled (not ready?)
                       :on-click on-open}]
     [:> icon-button* {:variant "ghost"
                       :aria-label (if (= pane :overlay)
                                     (tr "penforge.preview.split")
                                     (tr "penforge.preview.overlay"))
                       :icon i/expand
                       :on-click on-mode}]
     (if live?
       [:> button* {:variant "ghost" :on-click on-stop}
        (tr "penforge.preview.stop")]
       [:> button* {:variant "ghost" :on-click on-start}
        (tr "penforge.preview.start")])
     [:> icon-button* {:variant "ghost"
                       :aria-label (tr "penforge.preview.close")
                       :icon i/close
                       :on-click on-close}]]))

(mf/defc message*
  {::mf/private true}
  [{:keys [text detail action-label on-action]}]
  [:div {:class (stl/css :message)}
   [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
    text]
   ;; technical detail, in English, for the developer persona only
   (when (some? detail)
     [:code {:class (stl/css :detail)} detail])
   (when on-action
     [:> button* {:variant "secondary" :on-click on-action}
      action-label])])

(mf/defc frame*
  {::mf/private true}
  [{:keys [url device reload-key dragging]}]
  [:div {:class (stl/css-case :frame-area true
                              :frame-area-mobile (= device :mobile))}
   [:iframe {:key (str url "#" reload-key)
             :class (stl/css-case :frame true
                                  :frame-mobile (= device :mobile)
                                  :frame-dragging dragging)
             :style {:inline-size (when (= device :mobile)
                                    (str preview/mobile-width "px"))}
             :src url
             :title (tr "penforge.preview.frame-title")
             :sandbox frame-sandbox
             :allow "clipboard-read; clipboard-write; fullscreen"}]])

(mf/defc body*
  {::mf/private true}
  [{:keys [preview dragging]}]
  (let [connected?   (mf/deref connected-ref)
        developer?   (mf/deref developer-ref)
        {:keys [status url code message device reload-key]} preview
        on-connect   (mf/use-fn #(st/emit! (chat/open-chat)))
        on-start     (mf/use-fn #(st/emit! (preview/start-preview)))
        on-build     (mf/use-fn #(st/emit! (build/start)))]
    (cond
      (and (= status :ready) (some? url))
      [:> frame* {:url url
                  :device device
                  :reload-key reload-key
                  :dragging dragging}]

      (not connected?)
      [:> message* {:text (tr "penforge.preview.not-connected")
                    :action-label (tr "penforge.preview.connect")
                    :on-action on-connect}]

      (= status :starting)
      [:div {:class (stl/css :message)}
       [:span {:class (stl/css :spinner) :aria-hidden true}]
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
        (status-label preview)]]

      (= code "not-configured")
      [:> message* {:text (tr "penforge.preview.not-built")
                    :action-label (tr "penforge.build")
                    :on-action on-build}]

      (= status :failed)
      [:> message* {:text (problem-text preview)
                    :detail (when developer? message)
                    :action-label (tr "penforge.preview.retry")
                    :on-action on-start}]

      :else
      [:> message* {:text (problem-text preview)
                    :action-label (tr "penforge.preview.start")
                    :on-action on-start}])))

(mf/defc logs*
  {::mf/private true}
  [{:keys [logs]}]
  (when (seq logs)
    [:details {:class (stl/css :logs)}
     [:summary {:class (stl/css :logs-summary)}
      (tr "penforge.preview.logs")]
     [:pre {:class (stl/css :logs-content)}
      (for [[index {:keys [stream text]}] (map-indexed vector logs)]
        [:span {:key index
                :class (stl/css-case :log-line true
                                     :log-stderr (= stream :stderr)
                                     :log-system (= stream :system))}
         text "\n"])]]))

(mf/defc resize-handle*
  "Drag handle on the left edge of the split pane."
  {::mf/private true}
  [{:keys [width on-drag on-drag-end]}]
  (let [start* (mf/use-ref nil)

        on-pointer-down
        (mf/use-fn
         (mf/deps width)
         (fn [event]
           (let [target (dom/get-target event)]
             (.setPointerCapture ^js target (.-pointerId ^js event))
             (mf/set-ref-val! start* {:x (.-clientX ^js event) :width width})
             (on-drag width))))

        on-pointer-move
        (mf/use-fn
         (mf/deps on-drag)
         (fn [event]
           (when-let [{:keys [x width]} (mf/ref-val start*)]
             (on-drag (preview/clamp-width (+ width (- x (.-clientX ^js event)))
                                           (max-split-width))))))

        on-pointer-up
        (mf/use-fn
         (mf/deps on-drag-end)
         (fn [event]
           (when-let [{:keys [x width]} (mf/ref-val start*)]
             (mf/set-ref-val! start* nil)
             (on-drag-end (+ width (- x (.-clientX ^js event)))))))]
    [:div {:class (stl/css :resize-handle)
           :role "separator"
           :aria-orientation "vertical"
           :aria-label (tr "penforge.preview.resize")
           :on-pointer-down on-pointer-down
           :on-pointer-move on-pointer-move
           :on-pointer-up on-pointer-up
           :on-lost-pointer-capture on-pointer-up}]))

(mf/defc preview-content*
  {::mf/private true}
  [{:keys [preview dragging]}]
  (let [developer? (mf/deref developer-ref)]
    [:*
     [:> toolbar* {:preview preview}]
     [:div {:class (stl/css :body)}
      [:> body* {:preview preview :dragging dragging}]]
     (when developer?
       [:> logs* {:logs (:logs preview)}])]))

(mf/defc split-pane*
  {::mf/private true}
  [{:keys [preview]}]
  (let [drag-width* (mf/use-state nil)
        drag-width  (deref drag-width*)
        width       (or drag-width (:width preview) preview/default-width)

        on-drag     (mf/use-fn #(reset! drag-width* %))
        on-drag-end (mf/use-fn
                     (fn [value]
                       (reset! drag-width* nil)
                       (st/emit! (preview/set-width value (max-split-width)))))]
    [:aside {:class (stl/css :pane)
             :style {:inline-size (str width "px")}
             :aria-label (tr "penforge.preview.title")}
     [:> resize-handle* {:width width
                         :on-drag on-drag
                         :on-drag-end on-drag-end}]
     [:> preview-content* {:preview preview
                           :dragging (some? drag-width)}]]))

(mf/defc overlay-pane*
  {::mf/private true}
  [{:keys [preview]}]
  (mf/with-effect []
    (let [on-key (fn [event]
                   (when (kbd/esc? event)
                     (st/emit! (preview/open-pane :split))))
          key    (events/listen js/document "keydown" on-key)]
      #(events/unlistenByKey key)))

  [:div {:class (stl/css :overlay)}
   [:section {:class (stl/css :overlay-dialog)
              :role "dialog"
              :aria-label (tr "penforge.preview.title")}
    [:> preview-content* {:preview preview :dragging false}]]])

(mf/defc preview-pane*
  "The preview pane or overlay of the open project, if shown."
  []
  (let [preview (mf/deref preview-ref)
        pane    (:pane preview)]
    (cond
      (= pane :split)
      [:> split-pane* {:preview preview}]

      (= pane :overlay)
      [:> overlay-pane* {:preview preview}]

      :else
      nil)))
