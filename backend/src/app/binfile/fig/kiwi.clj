;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.binfile.fig.kiwi
  "Decoder of the Kiwi binary format, the encoding of a Figma `.fig`
  payload.

  A `.fig` file carries its own schema: the first chunk is a binary Kiwi
  schema and the second one a message encoded with it. Decoding is
  driven by that schema, so a field this namespace does not know is
  decoded like any other and the mapping step is free to ignore it.

  Values come back as plain data: a message is a map with only the
  fields present in the payload, a struct is a map with all its fields,
  an enum value is a keyword with the name of the value, a `byte[]` is a
  byte array and any other array is a vector. Field names are kept as
  they are in the schema (camelCase keywords), so the mapping code reads
  the names the format uses.

  Every length read from the payload is checked against what is left of
  it before anything is allocated, and nesting is bounded, so a hostile
  file fails with a validation error instead of exhausting the memory or
  the stack."
  (:refer-clojure :exclude [read-string])
  (:require
   [app.common.exceptions :as ex])
  (:import
   java.nio.BufferUnderflowException
   java.nio.ByteBuffer
   java.nio.ByteOrder
   java.nio.charset.StandardCharsets))

(set! *warn-on-reflection* true)

(def ^:const max-depth
  "How deep messages may nest. A Figma document nests nodes through
  `parentIndex`, not through the payload: only overrides nest messages,
  a few levels deep."
  64)

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; PRIMITIVES
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- invalid
  [hint & {:as data}]
  (ex/raise :type :validation
            :code :invalid-fig-file
            :hint hint
            ::data data))

(defn buffer
  "A little endian reader over `data`."
  ^ByteBuffer [^bytes data]
  (-> (ByteBuffer/wrap data)
      (.order ByteOrder/LITTLE_ENDIAN)))

(defn- remaining
  ^long [^ByteBuffer bb]
  (.remaining bb))

(defn read-byte
  ^long [^ByteBuffer bb]
  (bit-and (long (.get bb)) 0xff))

(defn read-bool
  [^ByteBuffer bb]
  (not (zero? (read-byte bb))))

(defn read-var-uint
  "An unsigned LEB128 value of up to 32 bits."
  ^long [^ByteBuffer bb]
  (loop [shift  0
         result 0]
    (let [b      (read-byte bb)
          result (bit-or result (bit-shift-left (bit-and b 0x7f) shift))]
      (if (and (not (zero? (bit-and b 0x80))) (< shift 28))
        (recur (+ shift 7) result)
        (bit-and result 0xffffffff)))))

(defn read-var-int
  "A zigzag encoded signed value of up to 32 bits."
  ^long [^ByteBuffer bb]
  (let [v (read-var-uint bb)]
    (if (zero? (bit-and v 1))
      (unsigned-bit-shift-right v 1)
      (- -1 (unsigned-bit-shift-right v 1)))))

(defn read-var-uint64
  "An unsigned LEB128 value of up to 64 bits: eight groups of seven bits
  and a last byte that uses all its eight. Returned as a long, so a value
  over 2^63 wraps; Figma only stores ids there."
  ^long [^ByteBuffer bb]
  (loop [shift  0
         result 0]
    (let [b (read-byte bb)]
      (if (= shift 56)
        (bit-or result (bit-shift-left b 56))
        (let [result (bit-or result (bit-shift-left (bit-and b 0x7f) shift))]
          (if (zero? (bit-and b 0x80))
            result
            (recur (+ shift 7) result)))))))

(defn read-var-int64
  ^long [^ByteBuffer bb]
  (let [v (read-var-uint64 bb)]
    (if (zero? (bit-and v 1))
      (unsigned-bit-shift-right v 1)
      (- -1 (unsigned-bit-shift-right v 1)))))

(defn read-var-float
  "A float32 stored with its exponent in the first byte, so zero takes a
  single byte: the stored bits are the float bits rotated left by nine."
  [^ByteBuffer bb]
  (let [first (read-byte bb)]
    (if (zero? first)
      0.0
      (let [b1   (read-byte bb)
            b2   (read-byte bb)
            b3   (read-byte bb)
            bits (bit-or first
                         (bit-shift-left b1 8)
                         (bit-shift-left b2 16)
                         (bit-shift-left b3 24))
            bits (bit-and (bit-or (bit-shift-left bits 23)
                                  (unsigned-bit-shift-right bits 9))
                          0xffffffff)]
        (double (Float/intBitsToFloat (unchecked-int bits)))))))

(defn read-string
  "A UTF-8 string ended by a zero byte."
  [^ByteBuffer bb]
  (let [start (.position bb)
        limit (.limit bb)
        end   (loop [i start]
                (cond
                  (>= i limit) (invalid "unterminated string")
                  (zero? (.get bb (int i))) i
                  :else (recur (inc i))))
        bytes (byte-array (- end start))]
    (.get bb bytes)
    (.get bb)
    (String. bytes StandardCharsets/UTF_8)))

(defn- read-length
  "A length that cannot be satisfied by what is left of the payload, read
  as an error before anything is allocated: every element takes at least
  one byte."
  ^long [^ByteBuffer bb]
  (let [n (read-var-uint bb)]
    (when (> n (remaining bb))
      (invalid "array length exceeds the payload" :length n))
    n))

(defn read-byte-array
  ^bytes [^ByteBuffer bb]
  (let [n   (read-length bb)
        out (byte-array n)]
    (.get bb out)
    out))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; SCHEMA
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(def builtin-types
  "The native types, by the negative id the binary schema gives them."
  {-1 :bool
   -2 :byte
   -3 :int
   -4 :uint
   -5 :float
   -6 :string
   -7 :int64
   -8 :uint64})

(def ^:private kinds
  {0 :enum
   1 :struct
   2 :message})

(defn- read-schema-definitions
  [^ByteBuffer bb]
  (let [n (read-length bb)]
    (loop [i 0 defs (transient [])]
      (if (< i n)
        (let [name   (read-string bb)
              kind   (or (get kinds (read-byte bb))
                         (invalid "unknown definition kind" :name name))
              nfield (read-length bb)
              fields (loop [j 0 fields (transient [])]
                       (if (< j nfield)
                         (let [fname (read-string bb)
                               type  (read-var-int bb)
                               array (read-bool bb)
                               value (read-var-uint bb)]
                           (recur (inc j)
                                  (conj! fields {:name   fname
                                                 :type   type
                                                 :array? array
                                                 :value  value})))
                         (persistent! fields)))]
          (recur (inc i) (conj! defs {:name name :kind kind :fields fields})))
        (persistent! defs)))))

(defn- resolve-field-type
  [defs {:keys [type] :as field}]
  (assoc field :type
         (if (neg? type)
           (or (get builtin-types type)
               (invalid "unknown native type" :type type))
           (if-let [def (get defs type)]
             (:name def)
             (invalid "field type out of range" :type type)))))

(defn decode-schema
  "The schema a binary Kiwi schema describes: the definitions in order and
  an index by name. Field types are resolved to a native type keyword or
  to the name of a definition."
  [^bytes data]
  (try
    (let [bb   (buffer data)
          defs (read-schema-definitions bb)
          ;; the type of an enum field means nothing: only its value counts
          defs (mapv (fn [def]
                       (if (= :enum (:kind def))
                         def
                         (update def :fields (partial mapv (partial resolve-field-type defs)))))
                     defs)]
      {:definitions defs
       :index       (into {} (map (juxt :name identity)) defs)})
    (catch BufferUnderflowException _
      (invalid "truncated kiwi schema"))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; MESSAGE
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(declare ^:private compile-definition)

(defn- native-reader
  [type]
  (case type
    :bool   read-bool
    :byte   read-byte
    :int    read-var-int
    :uint   read-var-uint
    :float  read-var-float
    :string read-string
    :int64  read-var-int64
    :uint64 read-var-uint64))

(defn- value-reader
  "The reader of one value of a field type: a native type or a
  definition, resolved lazily so definitions can refer to each other."
  [readers type]
  (if (keyword? type)
    (let [f (native-reader type)]
      (fn [bb _depth] (f bb)))
    (fn [bb depth]
      (let [f (or (get @readers type)
                  (invalid "unknown definition" :name type))]
        (f bb depth)))))

(defn- field-reader
  [readers {:keys [type array?]}]
  (cond
    (and array? (= type :byte))
    (fn [bb _depth] (read-byte-array bb))

    array?
    (let [f (value-reader readers type)]
      (fn [bb depth]
        (let [n (read-length bb)]
          (loop [i 0 out (transient [])]
            (if (< i n)
              (recur (inc i) (conj! out (f bb depth)))
              (persistent! out))))))

    :else
    (value-reader readers type)))

(defn- compile-definition
  [readers {:keys [name kind fields]}]
  (case kind
    :enum
    (let [values (into {} (map (fn [f] [(:value f) (keyword (:name f))])) fields)]
      (fn [bb _depth]
        (let [v (read-var-uint bb)]
          (or (get values v) v))))

    :struct
    (let [fields (mapv (fn [f] [(keyword (:name f)) (field-reader readers f)]) fields)]
      (fn [bb depth]
        (when (> depth max-depth)
          (invalid "kiwi payload nests too deep"))
        (let [depth (inc depth)]
          (persistent!
           (reduce (fn [out [k f]] (assoc! out k (f bb depth)))
                   (transient {})
                   fields)))))

    :message
    (let [by-tag (into {} (map (fn [f] [(:value f) [(keyword (:name f)) (field-reader readers f)]]))
                       fields)]
      (fn [bb depth]
        (when (> depth max-depth)
          (invalid "kiwi payload nests too deep"))
        (let [depth (inc depth)]
          (loop [out (transient {})]
            (let [tag (read-var-uint bb)]
              (if (zero? tag)
                (persistent! out)
                (if-let [[k f] (get by-tag tag)]
                  (recur (assoc! out k (f bb depth)))
                  ;; kiwi has no wire types: an unknown field cannot be
                  ;; skipped, the rest of the payload is unreadable
                  (invalid "unknown field in kiwi message" :message name :tag tag))))))))))

(defn compile-schema
  "A decoder per definition of the schema, by name."
  [{:keys [definitions]}]
  (let [readers (volatile! {})]
    (vreset! readers (into {} (map (fn [def] [(:name def) (compile-definition readers def)]))
                           definitions))
    @readers))

(defn decode-message
  "Decode `data` as the definition named `root` of a compiled schema."
  ([decoders ^bytes data]
   (decode-message decoders "Message" data))
  ([decoders root ^bytes data]
   (let [f (or (get decoders root)
               (invalid "the schema has no root definition" :root root))]
     (try
       (f (buffer data) 0)
       (catch BufferUnderflowException _
         (invalid "truncated kiwi message"))))))
