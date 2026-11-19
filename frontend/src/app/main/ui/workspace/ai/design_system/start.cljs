;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-system.start
  "Start card of the AI chat in a design system file (W29): upload a
  DESIGN.md or describe the brand, import an icon set (GitHub URL or
  `.fig` file), publish as a shared library. Progress, the license and
  publish questions show in the chat timeline below it."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.design-system :as ds]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.design-system.fig :as fig]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

(def max-design-md-bytes
  "Largest DESIGN.md accepted (the daemon's limit too)."
  (* 256 1024))

(def ^:private ref:mode
  (l/derived (fn [state]
               (when (ds/design-system-file? state)
                 {:marker    (ds/current-marker state)
                  :shared    (ds/shared? state)
                  :can-edit  (ds/can-edit? state)
                  :running   (ds/running state)
                  :fig       (get-in state fig/fig-path)
                  :connected (= :connected (get-in state [:penforge :connection :status]))}))
             st/state
             =))

(defn fig-status-text
  "Translated text of the `.fig` import status, or nil."
  [{:keys [status code] n :count}]
  (case status
    :uploading (tr "penforge.design-systems.fig.uploading")
    :importing (tr "penforge.design-systems.fig.importing")
    :reading   (tr "penforge.design-systems.fig.reading")
    :sent      (tr "penforge.design-systems.fig.sent" n)
    :error     (case code
                 "no-icons"  (tr "penforge.design-systems.fig.no-icons")
                 "no-drafts" (tr "penforge.design-systems.fig.failed")
                 (tr "penforge.design-systems.fig.failed"))
    nil))

(mf/defc start-card*
  "The card itself, from plain props (rendered by tests too)."
  [{:keys [marker shared can-edit running fig connected
           on-design-md on-describe on-github on-fig on-publish]}]
  (let [description*  (mf/use-state "")
        description   (deref description*)
        url*          (mf/use-state "")
        url           (deref url*)
        problem*      (mf/use-state nil)
        problem       (deref problem*)
        md-input-ref  (mf/use-ref nil)
        fig-input-ref (mf/use-ref nil)

        generated?    (some? (:generated-at marker))
        fig-busy?     (contains? #{:uploading :importing :reading} (:status fig))
        disabled?     (or (not connected) (not can-edit) (some? running))

        pick-md
        (mf/use-fn #(some-> (mf/ref-val md-input-ref) (.click)))

        pick-fig
        (mf/use-fn #(some-> (mf/ref-val fig-input-ref) (.click)))

        on-md-change
        (mf/use-fn
         (mf/deps on-design-md)
         (fn [event]
           (let [target (dom/get-target event)
                 file   (some-> target .-files (aget 0))]
             (when file
               (if (> (.-size file) max-design-md-bytes)
                 (reset! problem* (tr "penforge.design-systems.design-md.too-large"))
                 (do (reset! problem* nil)
                     (p/then (.text file)
                             (fn [text] (on-design-md text (.-name file)))))))
             (set! (.-value target) ""))))

        on-fig-change
        (mf/use-fn
         (mf/deps on-fig)
         (fn [event]
           (let [target (dom/get-target event)
                 file   (some-> target .-files (aget 0))]
             (when file
               (on-fig file))
             (set! (.-value target) ""))))

        on-description
        (mf/use-fn #(reset! description* (dom/get-target-val %)))

        on-url
        (mf/use-fn #(reset! url* (dom/get-target-val %)))

        describe
        (mf/use-fn
         (mf/deps description on-describe)
         (fn []
           (when-not (str/blank? description)
             (on-describe (str/trim description)))))

        github
        (mf/use-fn
         (mf/deps url on-github)
         (fn []
           (when-not (str/blank? url)
             (on-github (str/trim url)))))]

    [:section {:class (stl/css :card)
               :data-testid "design-system-start"}
     [:header {:class (stl/css :header)}
      [:> text* {:as "h3" :typography t/headline-small :class (stl/css :title)}
       (tr "penforge.design-systems.start.title")]
      (when-let [ds-name (:name marker)]
        [:span {:class (stl/css :name) :title ds-name} ds-name])]

     [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
      (if generated?
        (tr "penforge.design-systems.start.hint-again")
        (tr "penforge.design-systems.start.hint"))]

     [:div {:class (stl/css :section)}
      [:div {:class (stl/css :row)}
       [:> button* {:variant "secondary"
                    :type "button"
                    :disabled disabled?
                    :on-click pick-md}
        (tr "penforge.design-systems.start.upload")]]
      [:input {:type "file"
               :ref md-input-ref
               :accept ".md,.markdown,text/markdown,text/plain"
               :class (stl/css :file-input)
               :tab-index -1
               :aria-hidden true
               :on-change on-md-change}]
      [:textarea {:class (stl/css :field :description)
                  :value description
                  :rows 3
                  :disabled disabled?
                  :aria-label (tr "penforge.design-systems.start.describe-label")
                  :placeholder (tr "penforge.design-systems.start.describe-placeholder")
                  :on-change on-description}]
      [:div {:class (stl/css :row)}
       [:> button* {:variant "primary"
                    :type "button"
                    :disabled (or disabled? (str/blank? description))
                    :on-click describe}
        (if generated?
          (tr "penforge.design-systems.start.rebuild")
          (tr "penforge.design-systems.start.create"))]]
      (when problem
        [:p {:class (stl/css :status :status-error) :role "alert"} problem])]

     [:div {:class (stl/css :section)}
      [:> text* {:as "h4" :typography t/body-large :class (stl/css :section-title)}
       (tr "penforge.design-systems.icons.title")]
      [:input {:type "url"
               :class (stl/css :field)
               :value url
               :disabled disabled?
               :aria-label (tr "penforge.design-systems.icons.url-label")
               :placeholder "https://github.com/lucide-icons/lucide/tree/main/icons"
               :on-change on-url}]
      [:div {:class (stl/css :row)}
       [:> button* {:variant "secondary"
                    :type "button"
                    :disabled (or disabled? (str/blank? url))
                    :on-click github}
        (tr "penforge.design-systems.icons.github")]
       [:> button* {:variant "secondary"
                    :type "button"
                    :disabled (or disabled? fig-busy?)
                    :on-click pick-fig}
        (tr "penforge.design-systems.icons.fig")]]
      [:input {:type "file"
               :ref fig-input-ref
               :accept ".fig"
               :class (stl/css :file-input)
               :tab-index -1
               :aria-hidden true
               :on-change on-fig-change}]
      (when-let [status (fig-status-text fig)]
        [:p {:class (stl/css-case :status true
                                  :status-error (= :error (:status fig)))
             :role "status"}
         status])]

     (cond
       shared
       [:> text* {:as "p" :typography t/body-small :class (stl/css :status)}
        (tr "penforge.design-systems.published")]

       generated?
       [:div {:class (stl/css :row)}
        [:> button* {:variant "secondary"
                     :type "button"
                     :disabled (or (not can-edit) (some? running))
                     :on-click on-publish}
         (tr "penforge.design-systems.action.publish")]])]))

(mf/defc design-system-start*
  "Start card above the chat timeline; renders nothing outside design
  system files."
  []
  (let [mode (mf/deref ref:mode)

        on-design-md
        (mf/use-fn #(st/emit! (ds/generate {:source "design-md" :text %1 :file-name %2})))

        on-describe
        (mf/use-fn #(st/emit! (ds/generate {:source "prompt" :text %})))

        on-github
        (mf/use-fn #(st/emit! (ds/import-github-icons %)))

        on-fig
        (mf/use-fn #(st/emit! (fig/import-fig-icons %)))

        on-publish
        (mf/use-fn #(st/emit! (ds/publish)))]

    (when (some? mode)
      [:> start-card* {:marker (:marker mode)
                       :shared (:shared mode)
                       :can-edit (:can-edit mode)
                       :running (:running mode)
                       :fig (:fig mode)
                       :connected (:connected mode)
                       :on-design-md on-design-md
                       :on-describe on-describe
                       :on-github on-github
                       :on-fig on-fig
                       :on-publish on-publish}])))
