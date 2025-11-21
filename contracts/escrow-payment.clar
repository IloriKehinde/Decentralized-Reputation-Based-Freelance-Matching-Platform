(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-ESCROW-NOT-FOUND u101)
(define-constant ERR-ALREADY-RELEASED u102)
(define-constant ERR-ALREADY-REFUNDED u103)
(define-constant ERR-INVALID-AMOUNT u104)
(define-constant ERR-DEADLINE-PASSED u105)
(define-constant ERR-DEADLINE-IN-FUTURE u106)
(define-constant ERR-DISPUTE-ACTIVE u107)
(define-constant ERR-DISPUTE-INACTIVE u108)
(define-constant ERR-ALREADY-VOTED u109)
(define-constant ERR-QUORUM-NOT-MET u110)
(define-constant ERR-TRANSFER-FAILED u111)

(define-constant QUORUM-PERCENT u66)
(define-constant DISPUTE-DURATION u2016)
(define-constant MIN-ESCROW-AMOUNT u1000)

(define-data-var escrow-nonce uint u0)

(define-map escrows uint
  {
    amount: uint,
    payer: principal,
    payee: principal,
    token: principal,
    deadline: uint,
    released: bool,
    refunded: bool,
    dispute-active: bool,
    votes-release: uint,
    votes-refund: uint,
    dispute-end-block: uint,
    created-at: uint
  }
)

(define-map voter-record {escrow-id: uint, voter: principal} bool)

(define-trait ft-trait
  ((transfer (uint principal principal (optional (buff 34))) (response bool uint)))
)

(define-read-only (get-escrow (id uint))
  (map-get? escrows id))

(define-read-only (has-voted (escrow-id uint) (voter principal))
  (map-get? voter-record {escrow-id: escrow-id, voter: voter}))

(define-public (create-escrow
    (amount uint)
    (payee principal)
    (token <ft-trait>)
    (deadline uint))
  (let ((id (var-get escrow-nonce))
        (caller tx-sender)
        (token-principal (contract-of token)))
    (asserts! (>= amount MIN-ESCROW-AMOUNT) (err ERR-INVALID-AMOUNT))
    (asserts! (> deadline block-height) (err ERR-DEADLINE-IN-FUTURE))
    (asserts! (not (is-eq payee caller)) (err ERR-NOT-AUTHORIZED))
    (try! (contract-call? token transfer amount caller (as-contract tx-sender) none))
    (map-set escrows id
      {
        amount: amount,
        payer: caller,
        payee: payee,
        token: token-principal,
        deadline: deadline,
        released: false,
        refunded: false,
        dispute-active: false,
        votes-release: u0,
        votes-refund: u0,
        dispute-end-block: u0,
        created-at: block-height
      }
    )
    (var-set escrow-nonce (+ id u1))
    (ok id)
  )
)

(define-public (release (escrow-id uint))
  (let ((escrow (unwrap! (map-get? escrows escrow-id) (err ERR-ESCROW-NOT-FOUND))))
    (asserts! (or (is-eq tx-sender (get payer escrow)) (is-eq tx-sender (get payee escrow))) (err ERR-NOT-AUTHORIZED))
    (asserts! (not (get released escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (not (get refunded escrow)) (err ERR-ALREADY-REFUNDED))
    (asserts! (not (get dispute-active escrow)) (err ERR-DISPUTE-ACTIVE))
    (asserts! (<= block-height (get deadline escrow)) (err ERR-DEADLINE-PASSED))
    (try! (as-contract (contract-call? (get token escrow) transfer (get amount escrow) tx-sender (get payee escrow) none)))
    (map-set escrows escrow-id (merge escrow {released: true}))
    (ok true)
  )
)

(define-public (refund (escrow-id uint))
  (let ((escrow (unwrap! (map-get? escrows escrow-id) (err ERR-ESCROW-NOT-FOUND))))
    (asserts! (is-eq tx-sender (get payer escrow)) (err ERR-NOT-AUTHORIZED))
    (asserts! (not (get released escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (not (get refunded escrow)) (err ERR-ALREADY-REFUNDED))
    (asserts! (not (get dispute-active escrow)) (err ERR-DISPUTE-ACTIVE))
    (asserts! (> block-height (get deadline escrow)) (err ERR-DEADLINE-PASSED))
    (try! (as-contract (contract-call? (get token escrow) transfer (get amount escrow) tx-sender (get payer escrow) none)))
    (map-set escrows escrow-id (merge escrow {refunded: true}))
    (ok true)
  )
)

(define-public (raise-dispute (escrow-id uint))
  (let ((escrow (unwrap! (map-get? escrows escrow-id) (err ERR-ESCROW-NOT-FOUND))))
    (asserts! (or (is-eq tx-sender (get payer escrow)) (is-eq tx-sender (get payee escrow))) (err ERR-NOT-AUTHORIZED))
    (asserts! (not (get released escrow)) (err ERR-ALREADY-RELEASED))
    (asserts! (not (get refunded escrow)) (err ERR-ALREADY-REFUNDED))
    (asserts! (not (get dispute-active escrow)) (err ERR-DISPUTE-ACTIVE))
    (map-set escrows escrow-id
      (merge escrow
        {
          dispute-active: true,
          dispute-end-block: (+ block-height DISPUTE-DURATION)
        }
      )
    )
    (ok true)
  )
)

(define-public (vote-on-dispute (escrow-id uint) (support-release bool))
  (let ((escrow (unwrap! (map-get? escrows escrow-id) (err ERR-ESCROW-NOT-FOUND))))
    (asserts! (get dispute-active escrow) (err ERR-DISPUTE-INACTIVE))
    (asserts! (< block-height (get dispute-end-block escrow)) (err ERR-DEADLINE-PASSED))
    (asserts! (is-none (map-get? voter-record {escrow-id: escrow-id, voter: tx-sender})) (err ERR-ALREADY-VOTED))
    (map-set voter-record {escrow-id: escrow-id, voter: tx-sender} true)
    (if support-release
      (map-set escrows escrow-id (merge escrow {votes-release: (+ (get votes-release escrow) u1)}))
      (map-set escrows escrow-id (merge escrow {votes-refund: (+ (get votes-refund escrow) u1)}))
    )
    (resolve-dispute escrow-id escrow)
    (ok true)
  )
)

(define-private (resolve-dispute (escrow-id uint) (escrow {
    amount: uint, payer: principal, payee: principal, token: principal,
    deadline: uint, released: bool, refunded: bool, dispute-active: bool,
    votes-release: uint, votes-refund: uint, dispute-end-block: uint, created-at: uint
  }))
  (let ((total-votes (+ (get votes-release escrow) (get votes-refund escrow))))
    (cond
      ((>= (* (get votes-release escrow) u100) (* total-votes QUORUM-PERCENT))
       (begin
         (try! (as-contract (contract-call? (get token escrow) transfer (get amount escrow) tx-sender (get payee escrow) none)))
         (map-set escrows escrow-id (merge escrow {released: true, dispute-active: false}))
       )
      )
      ((>= (* (get votes-refund escrow) u100) (* total-votes QUORUM-PERCENT))
       (begin
         (try! (as-contract (contract-call? (get token escrow) transfer (get amount escrow) tx-sender (get payer escrow) none)))
         (map-set escrows escrow-id (merge escrow {refunded: true, dispute-active: false}))
       )
      )
      ((>= block-height (get dispute-end-block escrow))
       (begin
         (try! (as-contract (contract-call? (get token escrow) transfer (get amount escrow) tx-sender (get payer escrow) none)))
         (map-set escrows escrow-id (merge escrow {refunded: true, dispute-active: false}))
       )
      )
      true
    )
  )
)