;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.binfile.fig.tree
  "The document tree of a decoded `.fig` message, and the views the
  mapping walks.

  A Figma message is a flat list of node changes; each one names its
  parent and a fractional position among its siblings. `index` turns it
  into a tree keyed by `sessionID:localID`.

  The mapping does not walk the nodes directly but views of them. A view
  is the node map plus where it sits in the walk:

  - `::path`: a key unique in the whole walk. A node outside any
    instance is its own key; a node an instance brings is the path of
    the instance, a slash and its key inside the symbol, so the same
    symbol node seen through two instances has two paths.
  - `::copy-root`: the path of the top instance the node is a copy of,
    nil outside a copy.
  - `::ref`: for a node inside a copy, the path of the node of the main
    component it copies, which is its path relative to the copy root.
  - `::opath`: the guid path Figma uses to address the node inside the
    copy root, to look up overrides.
  - `::overridden`: the fields an override changed on the node.
  - `::in-main`: whether a main component encloses the node.

  An instance stores no children of its own: they are the children of
  its symbol, with the overrides of the instance (and of the instances
  around it) and the geometry Figma resolved for that instance applied."
  (:require
   [app.common.exceptions :as ex]))

(def ^:const max-instance-depth
  "How many instances may nest inside each other."
  32)

(defn guid-key
  "The key of a GUID struct: `sessionID:localID`."
  [{:keys [sessionID localID]}]
  (when (and (some? sessionID) (some? localID))
    (str sessionID ":" localID)))

(defn- compare-positions
  "Order two siblings by their fractional index, comparing code points as
  Figma does (not with a locale)."
  [a b]
  (compare (or (get-in a [:parentIndex :position]) "")
           (or (get-in b [:parentIndex :position]) "")))

(defn index
  "The tree of a decoded message: nodes by key, each one with
  `::key`, `::parent` and the keys of its children in z-order (back to
  front), plus the key of the document root and the blobs."
  [{:keys [nodeChanges blobs]}]
  (let [nodes (->> nodeChanges
                   (remove #(= :REMOVED (:phase %)))
                   (keep (fn [node]
                           (when-let [key (guid-key (:guid node))]
                             (assoc node
                                    ::key key
                                    ::parent (guid-key (get-in node [:parentIndex :guid]))))))
                   (reduce (fn [acc node] (assoc acc (::key node) node)) {}))
        children (->> (vals nodes)
                      (filter #(contains? nodes (::parent %)))
                      (group-by ::parent))
        nodes    (reduce-kv (fn [acc parent kids]
                              (assoc-in acc [parent ::children]
                                        (mapv ::key (sort compare-positions kids))))
                            nodes
                            children)
        root     (or (some (fn [[k n]] (when (= :DOCUMENT (:type n)) k)) nodes)
                     (ex/raise :type :validation
                               :code :invalid-fig-file
                               :hint "the file has no document node"))]
    {:nodes nodes
     :root  root
     :blobs (mapv :bytes blobs)}))

(defn node
  [tree key]
  (get-in tree [:nodes key]))

(defn pages
  "The canvas nodes of the document, in order, split into the ones the
  user sees and the internal one that holds styles and remote
  components."
  [tree]
  (let [canvases (->> (::children (node tree (:root tree)))
                      (map (partial node tree))
                      (filter #(= :CANVAS (:type %))))]
    {:pages    (vec (remove :internalOnly canvases))
     :internal (vec (filter :internalOnly canvases))}))

(defn ancestors-of
  "The keys of the ancestors of a node, nearest first."
  [tree key]
  (loop [key (::parent (node tree key)) out []]
    (if (and key (node tree key))
      (recur (::parent (node tree key)) (conj out key))
      out)))

(defn symbol-key
  "The key of the symbol an instance shows, nil when it has none."
  [node]
  (guid-key (get-in node [:symbolData :symbolID])))

(defn override-key
  "The key Figma uses to address a node from an instance: its override
  key when it has one, its guid otherwise."
  [node]
  (or (guid-key (:overrideKey node))
      (guid-key (:guid node))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; VIEWS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def ^:private override-ignored-keys
  "Fields of an override that identify it instead of changing the node."
  #{:guidPath :guid :parentIndex :overrideKey :type :symbolData
    :derivedSymbolData ::key ::parent ::children})

(def ^:private derived-keys
  "The fields Figma resolves per instance after the layout runs."
  #{:size :transform})

(defn- guid-path
  [entry]
  (into [] (keep guid-key) (get-in entry [:guidPath :guids])))

(defn- entries-by-path
  "Override entries keyed by their guid path, prefixed with `prefix`."
  [entries prefix keep-keys]
  (reduce (fn [acc entry]
            (let [path (guid-path entry)]
              (if (seq path)
                (let [fields (cond->> (apply dissoc entry override-ignored-keys)
                               keep-keys (into {} (filter (comp keep-keys key))))]
                  (update acc (into prefix path) merge fields))
                acc)))
          {}
          entries))

(defn root-view
  "The view of a node outside any instance."
  [tree key]
  (assoc (node tree key)
         ::path key
         ::opath []
         ::in-main false))

(defn- child-view
  [tree parent key]
  (let [n (node tree key)]
    (if-let [root (::copy-root parent)]
      (let [opath      (conj (::ipath parent) (override-key n))
            override   (get-in parent [::overrides opath])
            derived    (get-in parent [::derived opath])
            path       (str (::path parent) "/" key)]
        (-> (merge n override derived)
            (assoc ::path path
                   ::copy-root root
                   ::ref (subs path (inc (count root)))
                   ::opath opath
                   ::ipath (::ipath parent)
                   ::overrides (::overrides parent)
                   ::derived (::derived parent)
                   ::overridden (set (keys override))
                   ::in-main (::in-main parent)
                   ::detached (::detached parent)
                   ::instance-chain (::instance-chain parent))))
      (assoc n
             ::path key
             ::opath []
             ::in-main (or (::in-main parent)
                           (and (= :SYMBOL (:type parent))
                                (not (:isStateGroup parent))))))))

(defn instance-children
  "The views of the children an instance shows: the children of its
  symbol with the overrides and the resolved geometry of the instance
  applied. Nil when the symbol is not in the file."
  [tree inst]
  (let [skey (symbol-key inst)
        sym  (node tree skey)
        chain (conj (or (::instance-chain inst) #{}) (::path inst))]
    (when (and sym (not (contains? (or (::symbols inst) #{}) skey)))
      (when (> (count chain) max-instance-depth)
        (ex/raise :type :validation
                  :code :invalid-fig-file
                  :hint "instances nest too deep"))
      (let [top?      (nil? (::copy-root inst))
            root      (or (::copy-root inst) (::path inst))
            ;; the guid path of the children of this instance, relative
            ;; to the copy root
            ipath     (if top? [] (::opath inst))
            own-ov    (entries-by-path (get-in inst [:symbolData :symbolOverrides]) ipath nil)
            own-der   (entries-by-path (:derivedSymbolData inst) ipath derived-keys)
            ;; the outer instances address the same nodes with longer
            ;; paths and win over the ones of this instance
            overrides (merge-with merge own-ov (if top? {} (::overrides inst)))
            derived   (merge-with merge own-der (if top? {} (::derived inst)))
            parent    (assoc inst
                             ::copy-root root
                             ::ipath ipath
                             ::overrides overrides
                             ::derived derived
                             ::instance-chain chain
                             ::symbols (conj (or (::symbols inst) #{}) skey))]
        (mapv (fn [key]
                (assoc (child-view tree parent key)
                       ::symbols (::symbols parent)))
              (::children sym))))))

(defn children
  "The views of the children of a view."
  [tree view]
  (if (= :INSTANCE (:type view))
    (or (instance-children tree view) [])
    (mapv (fn [key]
            (cond-> (child-view tree view key)
              (::symbols view) (assoc ::symbols (::symbols view))))
          (::children view))))
