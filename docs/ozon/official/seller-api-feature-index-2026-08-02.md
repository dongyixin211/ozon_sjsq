# Ozon Seller API 功能索引

> 来源：Ozon 官方 Seller API 文档（英文 Swagger 镜像，中文页面在当前网络环境连接被对端关闭）。
> 下载日期：2026-08-02；Swagger 版本：2.1；Host：
> 原始文件：`seller-api-swagger-2026-08-02.json`。

## 本项目重点接口

| 能力 | 官方接口 | 本项目用途 |
|---|---|---|
| 活动列表 | `POST /v1/actions` | 读取店铺可参加活动及自动加入时间 |
| 活动商品 | `POST /v1/actions/products` | 查询活动内商品和活动价 |
| 加入/更新活动商品 | `POST /v1/actions/products/activate` | 按类目规则校正活动价 |
| 移除活动商品 | `POST /v1/actions/products/deactivate` | 清理非受控活动或持续低价商品 |
| 自动加入商品列表 | `POST /v1/actions/auto-add/products/list` | 识别 Ozon 自动加入资格 |
| 删除自动加入资格 | `POST /v1/actions/auto-add/products/delete` | 防止商品被 Ozon 自动加回 |
| 商品价格 | `POST /v5/product/info/prices` | 读取卖家营销价、展示价、最低价和自动活动状态 |
| 折扣申请 | `POST /v2/actions/discounts-task/list` | 检查客户折扣请求 |
| 拒绝折扣申请 | `POST /v1/actions/discounts-task/decline` | 拒绝低于规则底价的请求 |

## 价格字段解释

- `price`：包含折扣后的商品展示价，不能单独作为亏损判断。
- `marketing_seller_price`：应用卖家承担的营销活动后的价格，作为本项目防亏判断的主要字段。
- `min_price`：所有活动应用后的最低价，用于风险提示。
- `auto_action_enabled`：商品是否开启活动自动应用。
- `marketing_actions.ozon_actions_exist`：是否存在由 Ozon 承担费用的活动；仅展示价降低且卖家营销价未低于规则底价时，只通知不移除。

## 全量接口

| Method | Path | Operation | Tag | Summary |
|---|---|---|---|---|
| GET | `/v1/actions` | `Promos` | Promos | Available special offers |
| POST | `/v1/actions/auto-add/products/candidates` | `ActionsAutoAddProductsCandidates` | PromosBeta | Get list of products available for auto-adding to the special offer |
| POST | `/v1/actions/auto-add/products/delete` | `ActionsAutoAddProductsDelete` | PromosBeta | Remove products from auto-adding to the special offer |
| POST | `/v1/actions/auto-add/products/list` | `ActionsAutoAddProductsList` | PromosBeta | Get list of products from auto-adding to the special offer |
| POST | `/v1/actions/auto-add/products/update` | `ActionsAutoAddProductsUpdate` | PromosBeta | Add or update products in the auto-adding to the special offer |
| POST | `/v1/actions/candidates` | `PromosCandidates` | Promos | Products that can participate in a special offer |
| POST | `/v1/actions/discounts-task/approve` | `promos_task_approve` | Promos | Approve a discount request |
| POST | `/v1/actions/discounts-task/decline` | `promos_task_decline` | Promos | Decline a discount request |
| POST | `/v1/actions/discounts-task/list` | `promos_task_list` | Promos | List of discount requests |
| POST | `/v1/actions/products` | `PromosProducts` | Promos | Products in a special offer |
| POST | `/v1/actions/products/activate` | `PromosProductsActivate` | Promos | Add products to special offer |
| POST | `/v1/actions/products/deactivate` | `PromosProductsDeactivate` | Promos | Remove products from special offer |
| POST | `/v1/analytics/data` | `AnalyticsAPI_AnalyticsGetData` | Premium | Analytics data |
| POST | `/v1/analytics/manage/stocks` | `AnalyticsAPI_ManageStocks` | BetaMethod | Stock management |
| POST | `/v1/analytics/product-queries` | `AnalyticsAPI_AnalyticsProductQueries` | Premium | Get details on your product queries |
| POST | `/v1/analytics/product-queries/details` | `AnalyticsAPI_AnalyticsProductQueriesDetails` | Premium | Get query details by product |
| POST | `/v1/analytics/stocks` | `AnalyticsAPI_AnalyticsStocks` | AnalyticsAPI | Get analytics on stock balances |
| POST | `/v1/analytics/turnover/stocks` | `AnalyticsAPI_StocksTurnover` | AnalyticsAPI | Product turnover |
| POST | `/v1/assembly/carriage/posting/list` | `AssemblyCarriagePostingList` | DeliveryFBS | Get list of shipments in shipping |
| POST | `/v1/assembly/carriage/product/list` | `AssemblyCarriageProductList` | DeliveryFBS | Get list of products in shipping |
| POST | `/v1/assembly/fbs/posting/list` | `AssemblyFbsPostingList` | DeliveryFBS | Get shipment list |
| POST | `/v1/assembly/fbs/product/list` | `AssemblyFbsProductList` | DeliveryFBS | Get list of products in shipments |
| POST | `/v1/barcode/add` | `add-barcode` | BarcodeAPI | Bind barcodes to products |
| POST | `/v1/barcode/generate` | `generate-barcode` | BarcodeAPI | Generate barcodes for products |
| POST | `/v1/brand/company-certification/list` | `BrandAPI_BrandCompanyCertificationList` | BrandAPI | List of certified brands |
| POST | `/v1/cancel-reason/list` | `CancelReasonList` | CancelReasonAPI | Cancellation reasons for shipments |
| POST | `/v1/cancel-reason/list-by-order` | `CancelReasonListByOrder` | CancelReasonAPI | Order cancellation reasons |
| POST | `/v1/cancel-reason/list-by-posting` | `CancelReasonAPI_CancelReasonListByPosting` | CancelReasonAPI | Cancellation reasons for a shipment |
| POST | `/v1/carriage/approve` | `CarriageAPI_CarriageApprove` | DeliveryFBS | Confirm shipping |
| POST | `/v1/carriage/cancel` | `CarriageAPI_CarriageCancel` | DeliveryFBS | Delete shipping |
| POST | `/v1/carriage/create` | `CarriageAPI_CarriageCreate` | DeliveryFBS | Create shipping |
| POST | `/v1/carriage/delivery/list` | `CarriageAPI_CarriageDeliveryList` | DeliveryFBS | List of delivery methods and shipments |
| POST | `/v1/carriage/ettn/status` | `CarriageEttnStatus` | DeliveryFBS | Get electronic waybill verification status for traceable FBS shipping |
| POST | `/v1/carriage/get` | `CarriageGet` | DeliveryFBS | Shipping details |
| POST | `/v1/carriage/pass/create` | `carriagePassCreate` | Pass | Create a pass |
| POST | `/v1/carriage/pass/delete` | `carriagePassDelete` | Pass | Delete pass |
| POST | `/v1/carriage/pass/update` | `carriagePassUpdate` | Pass | Update pass |
| POST | `/v1/carriage/set-postings` | `CarriageAPI_SetPostings` | DeliveryFBS | Change shipping composition |
| POST | `/v1/chat/send/file` | `ChatAPI_ChatSendFile` | ChatAPI | Send file |
| POST | `/v1/chat/send/message` | `ChatAPI_ChatSendMessage` | Premium | Send message |
| POST | `/v1/chat/start` | `ChatAPI_ChatStart` | Premium | Create a new chat |
| POST | `/v1/cluster/list` | `SupplyDraftAPI_DraftClusterList` | FboSupplyRequest | Information about clusters and their warehouses |
| POST | `/v1/delivery/check` | `DeliveryCheck` | DeliveryAPI | Check delivery availability for customer |
| POST | `/v1/delivery/map` | `DeliveryMap` | DeliveryAPI | Display points on map |
| POST | `/v1/delivery/point/info` | `DeliveryPointInfo` | DeliveryAPI | Get pick-up point information |
| POST | `/v1/delivery/point/list` | `DeliveryAPI_DeliveryPointList` | DeliveryAPI | Get pick-up point list |
| POST | `/v1/delivery-method/list` | `WarehouseAPI_DeliveryMethodList` | WarehouseAPI | List of delivery methods for a warehouse |
| POST | `/v1/description-category/attribute` | `DescriptionCategoryAPI_GetAttributes` | CategoryAPI | Category characteristics list |
| POST | `/v1/description-category/attribute/values` | `DescriptionCategoryAPI_GetAttributeValues` | CategoryAPI | Characteristics value directory |
| POST | `/v1/description-category/attribute/values/search` | `DescriptionCategoryAPI_SearchAttributeValues` | CategoryAPI | Search by reference values of a characteristic |
| POST | `/v1/description-category/tips` | `DescriptionCategoryTips` | BetaMethod | Get tips to identify product category |
| POST | `/v1/description-category/tree` | `DescriptionCategoryAPI_GetTree` | CategoryAPI | Tree of product category and type |
| POST | `/v1/fbp/act-from/create` | `FbpAPI_FbpCreateAct` | DeliveryFBP | Generate acceptance certificate |
| POST | `/v1/fbp/act-from/get` | `FbpAPI_FbpCheckActState` | DeliveryFBP | Get status of acceptance certificate generation |
| POST | `/v1/fbp/act-to/create` | `FbpAPI_FbpCreateConsignmentNote` | DeliveryFBP | Generate waybill |
| POST | `/v1/fbp/act-to/get` | `FbpAPI_FbpCheckConsignmentNoteState` | DeliveryFBP | Get status of waybill generation |
| POST | `/v1/fbp/archive/get` | `FbpAPI_FbpArchiveGet` | DeliveryFBP | Get details on completed supply |
| POST | `/v1/fbp/archive/list` | `FbpAPI_FbpArchiveList` | DeliveryFBP | Get list of completed supplies |
| POST | `/v1/fbp/draft/direct/create` | `FbpDraftDirectCreate` | DraftDirectFBP | Create supply request draft without specifying delivery method |
| POST | `/v1/fbp/draft/direct/delete` | `FbpDraftDirectDelete` | DraftDirectFBP | Delete draft of supply request |
| POST | `/v1/fbp/draft/direct/product/validate` | `FbpDraftDirectProductValidate` | DraftDirectFBP | Validate product list for partner warehouse |
| POST | `/v1/fbp/draft/direct/registrate` | `FbpDraftDirectRegistrate` | DraftDirectFBP | Transfer draft to current supply |
| POST | `/v1/fbp/draft/direct/seller-dlv/create` | `FbpDraftDirectSellerDlvCreate` | DraftDirectFBP | Create draft with delivery by seller |
| POST | `/v1/fbp/draft/direct/seller-dlv/edit` | `FbpDraftDirectSellerDlvEdit` | DraftDirectFBP | Update draft with information about delivery by seller |
| POST | `/v1/fbp/draft/direct/timeslot/edit` | `FbpDraftDirectTimeslotEdit` | DraftDirectFBP | Edit time slot in draft |
| POST | `/v1/fbp/draft/direct/timeslot/get` | `FbpDraftDirectGetTimeslot` | DraftDirectFBP | Get list of time slots for direct supply |
| POST | `/v1/fbp/draft/direct/tpl-dlv/create` | `FbpAPI_FbpDraftDirectTplDlvCreate` | DraftDirectFBP | Create supply request for delivery by a third-party transport company |
| POST | `/v1/fbp/draft/direct/tpl-dlv/edit` | `FbpAPI_FbpDraftDirectTplDlvEdit` | DraftDirectFBP | Edit a draft of shipment with a third-party transport company |
| POST | `/v1/fbp/draft/drop-off/create` | `FbpDraftDropOffCreate` | DraftDropOffFBP | Create draft for delivery to drop-off point |
| POST | `/v1/fbp/draft/drop-off/delete` | `FbpDraftDropOffDelete` | DraftDropOffFBP | Delete draft for delivery to drop-off point |
| POST | `/v1/fbp/draft/drop-off/dlv/edit` | `FbpDraftDropOffDlvEdit` | DraftDropOffFBP | Edit delivery details for drop-off draft |
| POST | `/v1/fbp/draft/drop-off/point/list` | `FbpDraftDropOffPointList` | DraftDropOffFBP | Get list of drop-off points in province |
| POST | `/v1/fbp/draft/drop-off/point/timetable` | `FbpDraftDropOffPointTimetable` | DraftDropOffFBP | Get drop-off point schedule |
| POST | `/v1/fbp/draft/drop-off/product/validate` | `FbpDraftDropOffProductValidate` | DraftDropOffFBP | Check product list that partner's warehouse can accept |
| POST | `/v1/fbp/draft/drop-off/province/list` | `FbpDraftDropOffProvinceList` | DraftDropOffFBP | Get province list |
| POST | `/v1/fbp/draft/drop-off/registrate` | `FbpDraftDropOffRegistrate` | DraftDropOffFBP | Transfer draft to current supply |
| POST | `/v1/fbp/draft/get` | `FbpAPI_FbpDraftGet` | DeliveryFBPDraft | Get information about supply draft |
| POST | `/v1/fbp/draft/list` | `FbpAPI_FbpDraftList` | DeliveryFBPDraft | Supply drafts list |
| POST | `/v1/fbp/draft/pick-up/create` | `FbpAPI_FbpDraftPickupCreate` | DraftPickupFBP | Create request draft for pick-up supply |
| POST | `/v1/fbp/draft/pick-up/delete` | `FbpAPI_FbpDraftPickUpDelete` | DraftPickupFBP | Cancel request draft for pick-up supply |
| POST | `/v1/fbp/draft/pick-up/dlv/edit` | `FbpAPI_FbpDraftPickupDlvEdit` | DraftPickupFBP | Update request draft for pick-up supply |
| POST | `/v1/fbp/draft/pick-up/product/validate` | `FbpAPI_FbpDraftPickUpProductValidate` | DraftPickupFBP | Validate product list for pick-up supply |
| POST | `/v1/fbp/draft/pick-up/registrate` | `FbpDraftPickUpRegistrate` | DraftPickupFBP | Transfer draft to current supply |
| POST | `/v1/fbp/label/create` | `FbpAPI_FbpCreateLabel` | DeliveryFBP | Create label generation task |
| POST | `/v1/fbp/label/get` | `FbpAPI_FbpGetLabel` | DeliveryFBP | Get status of label generation task |
| POST | `/v1/fbp/order/direct/cancel` | `FbpAPI_FbpOrderDirectCancel` | OrderDirectFBP | Cancel supply |
| POST | `/v1/fbp/order/direct/seller-dlv/edit` | `FbpAPI_FbpOrderDirectSellerDlvEdit` | OrderDirectFBP | Update information about delivery by seller |
| POST | `/v1/fbp/order/direct/timeslot/edit` | `FbpAPI_FbpEditTimeslot` | OrderDirectFBP | Edit time slot in supply request |
| POST | `/v1/fbp/order/direct/timeslot/list` | `FbpAPI_FbpAvailableTimeslotList` | OrderDirectFBP | Get list of time slots for supply |
| POST | `/v1/fbp/order/drop-off/cancel` | `FbpAPI_FbpOrderDropOffCancel` | OrderDropOffFBP | Cancel supply to drop-off point |
| POST | `/v1/fbp/order/drop-off/dlv/edit` | `FbpAPI_FbpOrderDropOffDlvEdit` | OrderDropOffFBP | Edit information about supply to drop-off point |
| POST | `/v1/fbp/order/drop-off/timetable` | `FbpAPI_FbpOrderDropOffTimetable` | OrderDropOffFBP | Get drop-off point working schedule |
| POST | `/v1/fbp/order/get` | `FbpAPI_FbpOrderGet` | DeliveryFBP | Get information about supply |
| POST | `/v1/fbp/order/list` | `FbpAPI_FbpOrderList` | DeliveryFBP | Get list of supplies |
| POST | `/v1/fbp/order/pick-up/cancel` | `FbpAPI_FbpOrderPickUpCancel` | OrderPickupFBP | Cancel pick-up supply |
| POST | `/v1/fbp/order/pick-up/dlv/edit` | `FbpAPI_FbpOrderPickUpDlvEdit` | OrderPickupFBP | Edit pick-up point details |
| POST | `/v1/fbp/warehouse/list` | `FbpWarehouseList` | DeliveryFBPDraft | Get partner warehouses list |
| POST | `/v1/fbs/posting/product/exemplar/update` | `PostingAPI_FbsPostingProductExemplarUpdate` | FBS&rFBSMarks | Update items data |
| POST | `/v1/finance/accrual/by-day` | `GetFinanceAccrualByDay` | BetaMethod | Get accruals per day |
| POST | `/v1/finance/accrual/postings` | `GetFinanceAccrualPostings` | BetaMethod | Get accruals for shipments |
| POST | `/v1/finance/accrual/types` | `GetFinanceAccrualTypes` | BetaMethod | Get accrual directory |
| POST | `/v1/finance/balance` | `GetFinanceBalanceV1` | BetaMethod | Get balance report |
| POST | `/v1/finance/cash-flow-statement/list` | `FinanceAPI_FinanceCashFlowStatementList` | ReportAPI | Financial report |
| POST | `/v1/finance/compensation` | `ReportAPI_GetCompensationReport` | FinanceAPI | Compensation report |
| POST | `/v1/finance/decompensation` | `ReportAPI_GetDecompensationReport` | FinanceAPI | Decompensation report |
| POST | `/v1/finance/document-b2b-sales` | `ReportAPI_CreateDocumentB2BSalesReport` | FinanceAPI | Legal entities sales register |
| POST | `/v1/finance/document-b2b-sales/json` | `ReportAPI_CreateDocumentB2BSalesJSONReport` | FinanceAPI | Legal entities sales register in JSON format |
| POST | `/v1/finance/mutual-settlement` | `ReportAPI_CreateMutualSettlementReport` | FinanceAPI | Mutual settlements report |
| POST | `/v1/finance/products/buyout` | `GetFinanceProductsBuyout` | FinanceAPI | Purchased product report |
| POST | `/v1/finance/realization/by-day` | `FinanceAPI_GetRealizationByDayReportV1` | Premium | Sales report per day |
| POST | `/v1/finance/realization/posting` | `FinanceAPI_GetRealizationReportV1` | FinanceAPI | Sales report by order |
| POST | `/v1/invoice/delete` | `invoice_delete` | SupplierAPI | Delete invoice link |
| POST | `/v1/invoice/file/upload` | `invoice_upload` | SupplierAPI | Invoice upload |
| POST | `/v1/notification/check` | `CheckNotification` | Notification | Check URL for notifications |
| POST | `/v1/notification/delete` | `DeleteNotification` | Notification | Delete URL for notifications |
| POST | `/v1/notification/enable` | `EnableNotification` | Notification | Enable or disable URL for notifications |
| POST | `/v1/notification/list` | `NotificationList` | Notification | Get information about connected URLs |
| POST | `/v1/notification/push-type/list` | `GetNotificationPushTypeList` | Notification | Get push notification types |
| POST | `/v1/notification/set` | `SetNotification` | Notification | Connect URL for notifications |
| POST | `/v1/notification/update` | `UpdateNotification` | Notification | Change URL for notifications |
| POST | `/v1/order/cancel` | `OrderAPI_OrderCancel` | OrderAPI | Cancel order |
| POST | `/v1/order/cancel/check` | `OrderAPI_OrderCancelCheck` | OrderAPI | Check if order can be canceled |
| POST | `/v1/order/cancel/status` | `OrderAPI_OrderCancelStatus` | OrderAPI | Get order cancellation status |
| POST | `/v1/pass/list` | `PassList` | Pass | List of passes |
| POST | `/v1/polygon/bind` | `PolygonAPI_BindPolygon` | PolygonAPI | Link delivery method to a delivery polygon |
| POST | `/v1/polygon/create` | `PolygonAPI_CreatePolygon` | PolygonAPI | Create delivery polygon |
| POST | `/v1/posting/cancel` | `PostingAPI_PostingCancel` | FboPostingAPI | Cancel shipment from order |
| POST | `/v1/posting/cancel/status` | `PostingAPI_PostingCancelStatus` | FboPostingAPI | Check shipment cancellation status |
| POST | `/v1/posting/carriage-available/list` | `PostingAPI_GetCarriageAvailableList` | DeliveryFBS | List of available shippings |
| POST | `/v1/posting/cutoff/set` | `PostingAPI_SetPostingCutoff` | DeliveryrFBS | Specify shipping date |
| POST | `/v1/posting/digital/codes/upload` | `UploadPostingCodes` | Digital | Upload digital product codes for shipping |
| POST | `/v1/posting/digital/list` | `ListPostingCodes` | Digital | Get shipments list |
| POST | `/v1/posting/fbo/cancel-reason/list` | `PostingAPI_GetPostingFboCancelReasonList` | FBO | Shipments cancellation reasons by FBO scheme |
| POST | `/v1/posting/fbp/get` | `GetFbpPosting` | BetaMethod | Get shipment details by identifier |
| POST | `/v1/posting/fbp/list` | `PostingFbpList` | DeliveryFBP | Get shipment list |
| POST | `/v1/posting/fbs/cancel-reason` | `PostingAPI_GetPostingFbsCancelReasonV1` | FBS | Shipment cancellation reasons |
| POST | `/v1/posting/fbs/package-label/create` | `PostingAPI_CreateLabelBatch` | FBS | Create a task to generate labeling |
| POST | `/v1/posting/fbs/package-label/get` | `PostingAPI_GetLabelBatch` | FBS | Get a labeling file |
| POST | `/v1/posting/fbs/pick-up-code/verify` | `PostingAPI_PostingFBSPickupCodeVerify` | FBS | Verify courier code |
| POST | `/v1/posting/fbs/product/traceable/attribute` | `PostingFbsProductTraceableAttribute` | DeliveryFBS | Get list of empty attributes for traceable products |
| POST | `/v1/posting/fbs/restrictions` | `PostingAPI_GetRestrictions` | FBS | Get drop-off point restrictions |
| POST | `/v1/posting/fbs/split` | `FbsSplit` | DeliveryFBS | Split the order into shipments without picking |
| POST | `/v1/posting/fbs/timeslot/change-restrictions` | `PostingAPI_PostingTimeslotChangeRestrictions` | DeliveryrFBS | Dates available for delivery reschedule |
| POST | `/v1/posting/fbs/timeslot/set` | `PostingAPI_SetPostingTimeslot` | DeliveryrFBS | Reschedule shipment delivery date |
| POST | `/v1/posting/fbs/traceable/split` | `PostingFbsTraceableSplit` | DeliveryFBS | Split shipment with traceable products |
| POST | `/v1/posting/global/etgb` | `PostingAPI_GetEtgb` | FBS | ETGB customs declarations |
| POST | `/v1/posting/marks` | `PostingAPI_PostingMarks` | FboPostingAPI | Get item labels from shipment |
| POST | `/v1/posting/unpaid-legal/product/list` | `PostingAPI_UnpaidLegalProductList` | FBS | List of unpaid products from legal entities |
| POST | `/v1/pricing-strategy/competitors/list` | `pricing_competitors` | PricingStrategyAPI | List of competitors |
| POST | `/v1/pricing-strategy/create` | `pricing_create` | PricingStrategyAPI | Create a pricing strategy |
| POST | `/v1/pricing-strategy/delete` | `pricing_delete` | PricingStrategyAPI | Delete a pricing strategy |
| POST | `/v1/pricing-strategy/info` | `pricing_info` | PricingStrategyAPI | Strategy info |
| POST | `/v1/pricing-strategy/list` | `pricing_list` | PricingStrategyAPI | List of strategies |
| POST | `/v1/pricing-strategy/product/info` | `pricing_items-info` | PricingStrategyAPI | Competitor's product price |
| POST | `/v1/pricing-strategy/products/add` | `pricing_items-add` | PricingStrategyAPI | Bind products to a strategy |
| POST | `/v1/pricing-strategy/products/delete` | `pricing_items-delete` | PricingStrategyAPI | Remove products from a strategy |
| POST | `/v1/pricing-strategy/products/list` | `pricing_items-list` | PricingStrategyAPI | List of products in a strategy |
| POST | `/v1/pricing-strategy/status` | `pricing_status` | PricingStrategyAPI | Change strategy status |
| POST | `/v1/pricing-strategy/strategy-ids-by-product-ids` | `pricing_ids` | PricingStrategyAPI | List of strategy identifiers |
| POST | `/v1/pricing-strategy/update` | `pricing_update` | PricingStrategyAPI | Update strategy |
| POST | `/v1/product/action/timer/status` | `ProductAPI_ActionTimerStatus` | Prices&StocksAPI | Get status of timer you've set |
| POST | `/v1/product/action/timer/update` | `ProductAPI_ActionTimerUpdate` | Prices&StocksAPI | Update the minimum price relevance timer |
| POST | `/v1/product/archive` | `ProductAPI_ProductArchive` | ProductAPI | Archive a product |
| POST | `/v1/product/attributes/update` | `ProductAPI_ProductUpdateAttributes` | ProductAPI | Update product characteristics |
| GET | `/v1/product/certificate/accordance-types` | `ProductAPI_ProductCertificateAccordanceTypes` | CertificationAPI | List of accordance types (version 1) |
| POST | `/v1/product/certificate/bind` | `ProductAPI_ProductCertificateBind` | CertificationAPI | Link the certificate to the product |
| POST | `/v1/product/certificate/create` | `ProductAPI_ProductCertificateCreate` | CertificationAPI | Adding certificates for products |
| POST | `/v1/product/certificate/delete` | `CertificateDelete` | CertificationAPI | Delete certificate |
| POST | `/v1/product/certificate/info` | `CertificateInfo` | CertificationAPI | Certificate information |
| POST | `/v1/product/certificate/list` | `CertificateList` | CertificationAPI | Certificates list |
| POST | `/v1/product/certificate/product_status/list` | `ProductStatusList` | CertificationAPI | Product statuses list |
| POST | `/v1/product/certificate/products/list` | `CertificateProductsList` | CertificationAPI | List of products associated with the certificate |
| POST | `/v1/product/certificate/rejection_reasons/list` | `RejectionReasonsList` | CertificationAPI | Possible certificate rejection reasons |
| POST | `/v1/product/certificate/status/list` | `CertificateStatusList` | CertificationAPI | Possible certificate statuses |
| GET | `/v1/product/certificate/types` | `ProductAPI_ProductCertificateTypes` | CertificationAPI | Directory of document types |
| POST | `/v1/product/certificate/unbind` | `CertificateUnbind` | CertificationAPI | Unbind products from a certificate |
| POST | `/v1/product/certification/list` | `ProductAPI_V1ProductCertificationList` | CertificationAPI | List of certified categories |
| POST | `/v1/product/digital/stocks/import` | `DigitalProductAPI_StocksImport` | Digital | Update quantity of digital products |
| POST | `/v1/product/import/info` | `ProductAPI_GetImportProductsInfo` | ProductAPI | Get the product import status |
| POST | `/v1/product/import/prices` | `ProductAPI_ImportProductsPrices` | Prices&StocksAPI | Update prices |
| POST | `/v1/product/import-by-sku` | `ProductAPI_ImportProductsBySKU` | ProductAPI | Create a product by SKU |
| POST | `/v1/product/info/description` | `ProductAPI_GetProductInfoDescription` | ProductAPI | Get product description |
| POST | `/v1/product/info/discounted` | `ProductAPI_GetProductInfoDiscounted` | Prices&StocksAPI | Get information about the markdown and the main product by the markdown product SKU |
| POST | `/v1/product/info/stocks-by-warehouse/fbo` | `GetProductInfoStocksByWarehouseFbo` | ProductAPI, BetaMethod | Get information about stocks in FBO warehouses |
| POST | `/v1/product/info/stocks-by-warehouse/fbs` | `ProductAPI_ProductStocksByWarehouseFbs` | Prices&StocksAPI | Stocks in seller's warehouses (FBS Ð¸ rFBS) |
| POST | `/v1/product/info/subscription` | `ProductAPI_GetProductInfoSubscription` | ProductAPI | Number of users subscribed to product availability alerts |
| POST | `/v1/product/info/warehouse/stocks` | `ProductInfoWarehouseStocks` | Prices&StocksAPI | Get information on stock in FBS and rFBS warehouse |
| POST | `/v1/product/info/wrong-volume` | `ProductAPI_ProductInfoWrongVolume` | ProductAPI | List of products with incorrect VWC |
| POST | `/v1/product/pictures/import` | `ProductAPI_ProductImportPictures` | ProductAPI | Upload and update product images |
| POST | `/v1/product/prices/details` | `ProductPricesDetails` | Premium | Get details on product prices |
| POST | `/v1/product/quant/info` | `QuantGetInfo` | Quants | Economy product information |
| POST | `/v1/product/quant/list` | `QuantProductList` | Quants | Economy products list |
| POST | `/v1/product/rating-by-sku` | `ProductAPI_GetProductRatingBySku` | ProductAPI | Get products' content rating by SKU |
| POST | `/v1/product/related-sku/get` | `ProductAPI_ProductGetRelatedSKU` | ProductAPI | Get related SKUs |
| POST | `/v1/product/stairway-discount/by-quantity/get` | `ProductAPI_GetProductStairwayDiscountByQuantity` | BetaMethod | Get quantity discount information |
| POST | `/v1/product/stairway-discount/by-quantity/set` | `ProductAPI_SetProductStairwayDiscountByQuantity` | BetaMethod | Manage quantity discounts |
| POST | `/v1/product/unarchive` | `ProductAPI_ProductUnarchive` | ProductAPI | Unarchive a product |
| POST | `/v1/product/update/discount` | `ProductAPI_ProductUpdateDiscount` | Prices&StocksAPI | Set a discount on a markdown product |
| POST | `/v1/product/update/offer-id` | `ProductAPI_ProductUpdateOfferID` | ProductAPI | Change product identifiers from the seller's system |
| POST | `/v1/product/visibility/info` | `ProductVisibilityInfo` | BetaMethod | Get product visibility details |
| POST | `/v1/product/visibility/set` | `ProductVisibilitySet` | BetaMethod | Set product visibility on Ozon and Ozon Select storefronts |
| POST | `/v1/question/answer/create` | `QuestionAnswer_Create` | Questions&Answers | Create answer to question |
| POST | `/v1/question/answer/delete` | `QuestionAnswer_Delete` | Questions&Answers | Delete answer to question |
| POST | `/v1/question/answer/list` | `QuestionAnswer_List` | Questions&Answers | List of answers to question |
| POST | `/v1/question/change-status` | `Question_ChangeStatus` | Questions&Answers | Change question statuses |
| POST | `/v1/question/count` | `Question_Count` | Questions&Answers | Number of questions by statuses |
| POST | `/v1/question/info` | `Question_Info` | Questions&Answers | Question details |
| POST | `/v1/question/list` | `Question_List` | Questions&Answers | Question list |
| POST | `/v1/question/top-sku` | `Question_TopSku` | Questions&Answers | Products with the most questions |
| POST | `/v1/rating/history` | `RatingAPI_RatingHistoryV1` | SellerRating | Get information on seller ratings for the period |
| POST | `/v1/rating/index/fbs/info` | `RatingAPI_GetFBSRatingIndexInfoV1` | SellerRating | Get FBS and rFBS error index |
| POST | `/v1/rating/index/fbs/posting/list` | `RatingAPI_ListFBSRatingIndexPostingsV1` | SellerRating | List of shipments that affected FBS and rFBS error index |
| POST | `/v1/rating/summary` | `RatingAPI_RatingSummaryV1` | SellerRating | Get information on current seller ratings |
| POST | `/v1/receipts/get` | `GetReceipt` | Receipt | Get receipt in PDF format |
| POST | `/v1/receipts/seller/list` | `ReceiptsSellerList` | Receipt | Get list of seller receipts |
| POST | `/v1/receipts/upload` | `UploadReceipt` | Receipt | Upload receipt |
| POST | `/v1/removal/from-stock/list` | `GetSupplierReturnsSummaryReport` | BetaMethod | Report on removal and disposal from FBO stock |
| POST | `/v1/removal/from-supply/list` | `GetSupplyReturnsSummaryReport` | BetaMethod | Report on removal and disposal from FBO supply |
| POST | `/v1/report/discounted/create` | `ReportAPI_CreateDiscountedReport` | ReportAPI | Report on markdown products |
| POST | `/v1/report/info` | `ReportAPI_ReportInfo` | ReportAPI | Report details |
| POST | `/v1/report/list` | `ReportAPI_ReportList` | ReportAPI | Reports list |
| POST | `/v1/report/marked-products-sales/create` | `CreateCompanyMarkedProductsSalesReport` | ReportAPI | Generate sales report of labeled products |
| POST | `/v1/report/placement/by-products/create` | `CreatePlacementByProductsReport` | ReportAPI | Get report on storage cost by products |
| POST | `/v1/report/placement/by-supplies/create` | `CreatePlacementBySuppliesReport` | ReportAPI | Get report on storage cost by supplies |
| POST | `/v1/report/postings/create` | `ReportAPI_CreateCompanyPostingsReport` | ReportAPI | Shipment report |
| POST | `/v1/report/products/create` | `ReportAPI_CreateCompanyProductsReport` | ReportAPI | Products report |
| POST | `/v1/report/realization/posting/create` | `CreateCompanyFinanceRealizationPostingReport` | BetaMethod | Get sales report by order |
| POST | `/v1/report/warehouse/stock` | `ReportAPI_CreateStockByWarehouseReport` | ReportAPI | Report on FBS warehouse stocks |
| POST | `/v1/return/giveout/barcode` | `ReturnAPI_GiveoutGetBarcode` | ReturnAPI | Value of barcode for return shipments |
| POST | `/v1/return/giveout/barcode-reset` | `ReturnAPI_GiveoutBarcodeReset` | ReturnAPI | Generate new barcode |
| POST | `/v1/return/giveout/get-pdf` | `ReturnAPI_GiveoutGetPDF` | ReturnAPI | Barcode for return shipment in PDF format |
| POST | `/v1/return/giveout/get-png` | `ReturnAPI_GiveoutGetPNG` | ReturnAPI | Barcode for return shipment in PNG format |
| POST | `/v1/return/giveout/info` | `ReturnAPI_GiveoutInfo` | ReturnAPI | Information on return shipment |
| POST | `/v1/return/giveout/is-enabled` | `ReturnAPI_GiveoutIsEnabled` | ReturnAPI | Check the ability to receive return shipments by barcode |
| POST | `/v1/return/giveout/list` | `ReturnAPI_GiveoutList` | ReturnAPI | Return shipments list |
| POST | `/v1/return/pass/create` | `returnPassCreate` | Pass | Create a return pass |
| POST | `/v1/return/pass/delete` | `returnPassDelete` | Pass | Delete return pass |
| POST | `/v1/return/pass/update` | `returnPassUpdate` | Pass | Update return pass |
| POST | `/v1/returns/company/fbs/info` | `returnsCompanyFBSInfo` | ReturnAPI | FBS returns quantity |
| POST | `/v1/returns/list` | `returnsList` | ReturnsAPI | Information about FBO and FBS returns |
| POST | `/v1/returns/rfbs/action/set` | `ReturnsAPI_ReturnsRfbsActionSet` | RFBSReturnsAPI | Pass available actions for rFBS returns |
| POST | `/v1/review/change-status` | `ReviewAPI_ReviewChangeStatus` | ReviewAPI | Change review status |
| POST | `/v1/review/comment/create` | `ReviewAPI_CommentCreate` | ReviewAPI | Leave a comment on the review |
| POST | `/v1/review/comment/delete` | `ReviewAPI_CommentDelete` | ReviewAPI | Delete a comment on a review |
| POST | `/v1/review/comment/list` | `ReviewAPI_CommentList` | ReviewAPI | List of comments for the review |
| POST | `/v1/review/count` | `ReviewAPI_ReviewCount` | ReviewAPI | Number of reviews by status |
| POST | `/v1/review/info` | `ReviewAPI_ReviewInfo` | ReviewAPI | Get review details |
| POST | `/v1/review/list` | `ReviewAPI_ReviewList` | ReviewAPI | Get a list of reviews |
| POST | `/v1/roles` | `AccessAPI_RolesByToken` | APIkey | Get a list of roles and methods based on the API key |
| POST | `/v1/search-queries/text` | `SearchQueriesAPI_SearchQueriesText` | Premium | Get list of search queries by text |
| POST | `/v1/search-queries/top` | `SearchQueriesAPI_SearchQueriesTop` | Premium | Get list of popular search queries |
| POST | `/v1/seller/info` | `SellerAPI_SellerInfo` | SellerInfo | Get information about seller account |
| POST | `/v1/seller/ozon-logistics/info` | `SellerAPI_SellerOzonLogisticsInfo` | SellerInfo | Get information about connecting to Ozon Delivery |
| POST | `/v1/seller-actions/archive` | `SellerActionsArchive` | SellerActions | Archive special offer |
| POST | `/v1/seller-actions/change-activity` | `SellerActionsChangeActivity` | SellerActions | Enable or disable special offer |
| POST | `/v1/seller-actions/create/discount` | `SellerActionsCreateDiscount` | SellerActions | Create special offer with "Discount" mechanics |
| POST | `/v1/seller-actions/create/discount-with-condition` | `SellerActionsCreateDiscountWithCondition` | SellerActions | Create special offer with "Discount of order amount" mechanics |
| POST | `/v1/seller-actions/create/installment` | `SellerActionsCreateInstallment` | SellerActions | Create special offer with "Interest-free installment" mechanics |
| POST | `/v1/seller-actions/create/multi-level-discount` | `SellerActionsCreateMultiLevelDiscount` | SellerActions | Create special offer with "Multi-level discount from the amount" mechanics |
| POST | `/v1/seller-actions/create/voucher` | `SellerActionsCreateVoucher` | SellerActions | Create special offer with "Discount by promo code" mechanics |
| POST | `/v1/seller-actions/list` | `SellerActionsList` | SellerActions | Get list of special offers |
| POST | `/v1/seller-actions/products/add` | `SellerActionsProductsAdd` | SellerActions | Add products to special offer |
| POST | `/v1/seller-actions/products/candidates` | `SellerActionsProductsCandidates` | SellerActions | Get list of products that can participate in special offer |
| POST | `/v1/seller-actions/products/delete` | `SellerActionsProductsDelete` | SellerActions | Remove products from special offer |
| POST | `/v1/seller-actions/products/list` | `SellerActionsProductsList` | SellerActions | Get list of products in special offer |
| POST | `/v1/seller-actions/update/discount` | `SellerActionsUpdateDiscount` | SellerActions | Update special offer with "Discount" mechanic |
| POST | `/v1/seller-actions/update/discount-with-condition` | `SellerActionsUpdateDiscountWithCondition` | SellerActions | Update special offer with "Discount of order amount" mechanic |
| POST | `/v1/seller-actions/update/installment` | `SellerActionsUpdateInstallment` | SellerActions | Update special offer with "Interest-free installment" mechanic |
| POST | `/v1/seller-actions/update/multi-level-discount` | `SellerActionsUpdateMultiLevelDiscount` | SellerActions | Update special offer with "Multi-level discount from the total amount" mechanic |
| POST | `/v1/seller-actions/update/voucher` | `SellerActionsUpdateVoucher` | SellerActions | Update special offer with "Discount by promo code" mechanic |
| POST | `/v1/seller-actions/voucher/get` | `SellerActionsVoucherGet` | SellerActions | Get file with promo codes in CSV format |
| GET | `/v1/supplier/available_warehouses` | `SupplierAPI_SupplierAvailableWarehouses` | FBO | Ozon warehouses workload |
| POST | `/v1/supply-order/bundle` | `SupplyOrderBundle` | FBO | Supply or supply request contents |
| POST | `/v1/supply-order/cancel` | `SupplyOrderAPI_SupplyOrderCancel` | FboSupplyRequest | Cancel supply request |
| POST | `/v1/supply-order/cancel/status` | `SupplyOrderAPI_SupplyOrderCancelStatus` | FboSupplyRequest | Get status of canceled supply request |
| POST | `/v1/supply-order/pass/create` | `SupplyOrderAPI_SupplyOrderPassCreate` | FBO | Specify driver and vehicle details |
| POST | `/v1/supply-order/pass/status` | `SupplyOrderAPI_SupplyOrderPassStatus` | FBO | Driver and vehicle details entry status |
| POST | `/v1/supply-order/status/counter` | `SupplyOrderAPI_SupplyOrderStatusCounter` | FBO | Number of supply requests by status |
| POST | `/v1/supply-order/timeslot/get` | `SupplyOrderAPI_GetSupplyOrderTimeslots` | FBO | Supply time slots |
| POST | `/v1/supply-order/timeslot/status` | `SupplyOrderAPI_GetSupplyOrderTimeslotStatus` | FBO | Supply time slot status |
| POST | `/v1/supply-order/timeslot/update` | `SupplyOrderAPI_UpdateSupplyOrderTimeslot` | FBO | Update supply time slot |
| POST | `/v1/warehouse/archive` | `ArchiveWarehouseFBS` | WarehouseAPI | Archive a warehouse |
| POST | `/v1/warehouse/fbo/list` | `SupplyDraftAPI_DraftGetWarehouseFboList` | FboSupplyRequest | Finding points to ship the supply |
| POST | `/v1/warehouse/fbs/create` | `WarehouseAPI_CreateWarehouseFBS` | FBSWarehouseSetup | Create a warehouse |
| POST | `/v1/warehouse/fbs/create/drop-off/list` | `WarehouseAPI_ListDropOffPointsForCreateFBSWarehouse` | FBSWarehouseSetup | Get a list of drop-off points to create a warehouse |
| POST | `/v1/warehouse/fbs/create/drop-off/timeslot/list` | `WarehouseFbsCreateDropOffTimeslotList` | FBSWarehouseSetup | Get list of time slots for creating warehouse with drop-off shipment |
| POST | `/v1/warehouse/fbs/create/pick-up/timeslot/list` | `WarehouseFbsCreatePickUpTimeslotList` | FBSWarehouseSetup | Get list of time slots for creating warehouse with pick-up shipment |
| POST | `/v1/warehouse/fbs/first-mile/update` | `UpdateWarehouseFBSFirstMile` | FBSWarehouseSetup | Update first mile |
| POST | `/v1/warehouse/fbs/pickup/courier/cancel` | `WarehouseFbsPickUpCourierCancel` | FBSWarehouseSetup | Cancel courier request for pickup shipments |
| POST | `/v1/warehouse/fbs/pickup/courier/create` | `WarehouseFbsPickUpCourierCreate` | FBSWarehouseSetup | Create courier request for pickup shipments |
| POST | `/v1/warehouse/fbs/pickup/history/list` | `WarehouseFbsPickUpHistoryList` | FBSWarehouseSetup | Get history of shippings to couriers |
| POST | `/v1/warehouse/fbs/pickup/planning/list` | `WarehouseFbsPickUpPlanningList` | FBSWarehouseSetup | Get warehouse list for courier delivery planning |
| POST | `/v1/warehouse/fbs/update` | `UpdateWarehouseFBS` | FBSWarehouseSetup | Update warehouse |
| POST | `/v1/warehouse/fbs/update/drop-off/list` | `WarehouseAPI_ListDropOffPointsForUpdateFBSWarehouse` | FBSWarehouseSetup | Get a list of drop-off points for changing warehouse details |
| POST | `/v1/warehouse/fbs/update/drop-off/timeslot/list` | `WarehouseFbsUpdateDropOffTimeslotList` | FBSWarehouseSetup | Get list of time slots for updating warehouse with drop-off shipment |
| POST | `/v1/warehouse/fbs/update/pick-up/timeslot/list` | `WarehouseFbsUpdatePickUpTimeslotList` | FBSWarehouseSetup | Get list of time slots for updating warehouse with pick-up shipment |
| POST | `/v1/warehouse/invalid-products/get` | `WarehouseInvalidProductsGet` | WarehouseAPI | Get list of products with FBS delivery restrictions. |
| POST | `/v1/warehouse/list` | `WarehouseAPI_WarehouseList` | WarehouseAPI | List of warehouses |
| POST | `/v1/warehouse/operation/status` | `GetWarehouseFBSOperationStatus` | WarehouseAPI | Get operation status |
| POST | `/v1/warehouse/unarchive` | `UnarchiveWarehouseFBS` | WarehouseAPI | Remove warehouse from archive |
| POST | `/v1/warehouse/warehouses-with-invalid-products` | `WarehouseWithInvalidProducts` | WarehouseAPI | Get list of warehouses with products restricted for delivery |
| POST | `/v2/actions/discounts-task/list` | `GetDiscountTaskListV2` | BetaMethod | Get list of discount requests |
| POST | `/v2/analytics/stock_on_warehouses` | `AnalyticsAPI_AnalyticsGetStockOnWarehousesV2` | AnalyticsAPI | Stocks and products report |
| POST | `/v2/carriage/delivery/list` | `CarriageDeliveryListV2` | DeliveryFBS | List of delivery methods and shippings |
| POST | `/v2/chat/read` | `ChatAPI_ChatReadV2` | Premium | Mark messages as read |
| POST | `/v2/cluster/list` | `DraftClusterList` | FboSupplyRequest | Get information about macrolocal clusters |
| POST | `/v2/conditional-cancellation/approve` | `CancellationAPI_ConditionalCancellationApproveV2` | CancellationAPI | Approve rFBS cancellation request |
| POST | `/v2/conditional-cancellation/list` | `CancellationAPI_GetConditionalCancellationListV2` | CancellationAPI | Get a list of rFBS cancellation requests |
| POST | `/v2/conditional-cancellation/reject` | `CancellationAPI_ConditionalCancellationRejectV2` | CancellationAPI | Reject rFBS cancellation request |
| POST | `/v2/delivery/checkout` | `DeliveryCheckout` | DeliveryAPI | Get available delivery options |
| POST | `/v2/delivery-method/list` | `WarehouseAPI_DeliveryMethodListV2` | WarehouseAPI | List of delivery methods for realFBS warehouses |
| POST | `/v2/fbs/posting/delivered` | `PostingAPI_FbsPostingDelivered` | DeliveryrFBS | Change the status to "Delivered" |
| POST | `/v2/fbs/posting/delivering` | `PostingAPI_FbsPostingDelivering` | DeliveryrFBS | Change the status to "Delivering" |
| POST | `/v2/fbs/posting/last-mile` | `PostingAPI_FbsPostingLastMile` | DeliveryrFBS | Change the status to "Last Mile" |
| POST | `/v2/fbs/posting/tracking-number/set` | `PostingAPI_FbsPostingTrackingNumberSet` | DeliveryrFBS | Add tracking numbers |
| POST | `/v2/finance/realization` | `FinanceAPI_GetRealizationReportV2` | FinanceAPI | Sales report (version 2) |
| POST | `/v2/invoice/create-or-update` | `InvoiceAPI_InvoiceCreateOrUpdateV2` | SupplierAPI | Create or edit an invoice |
| POST | `/v2/invoice/get` | `invoice_getV2` | SupplierAPI | Get invoice information |
| POST | `/v2/order/create` | `OrderAPI_OrderCreate` | OrderAPI | Create order |
| POST | `/v2/posting/digital/list` | `PostingDigitalList` | BetaMethod | Get shipment list |
| POST | `/v2/posting/fbo/get` | `PostingAPI_GetFboPosting` | FBO | Shipment details |
| POST | `/v2/posting/fbo/list` | `PostingAPI_GetFboPostingList` | FBO | Shipments list |
| POST | `/v2/posting/fbs/act/check-status` | `PostingAPI_PostingFBSActCheckStatus` | DeliveryFBS | Status of acceptance and transfer certificate and waybill |
| POST | `/v2/posting/fbs/act/create` | `PostingAPI_PostingFBSActCreate` | DeliveryFBS | Create an acceptance and transfer certificate and a waybill |
| POST | `/v2/posting/fbs/act/get-barcode` | `PostingAPI_PostingFBSGetBarcode` | DeliveryFBS | Barcode for product shipping |
| POST | `/v2/posting/fbs/act/get-barcode/text` | `PostingAPI_PostingFBSGetBarcodeText` | DeliveryFBS | Value of barcode for product shipping |
| POST | `/v2/posting/fbs/act/get-container-labels` | `PostingAPI_PostingFBSActGetContainerLabels` | DeliveryFBS | Package unit labels |
| POST | `/v2/posting/fbs/act/get-pdf` | `PostingAPI_PostingFBSGetAct` | DeliveryFBS | Get acceptance and transfer certificate and waybill |
| POST | `/v2/posting/fbs/act/get-postings` | `PostingAPI_ActPostingList` | DeliveryFBS | List of shipments in the certificate |
| POST | `/v2/posting/fbs/act/list` | `PostingAPI_FbsActList` | DeliveryFBS | List of shipping certificates |
| POST | `/v2/posting/fbs/arbitration` | `PostingAPI_MoveFbsPostingToArbitration` | FBS | Open a dispute over a shipment |
| POST | `/v2/posting/fbs/awaiting-delivery` | `PostingAPI_MoveFbsPostingToAwaitingDelivery` | FBS | Pass the shipment to shipping |
| POST | `/v2/posting/fbs/cancel` | `PostingAPI_CancelFbsPosting` | FBS | Cancel the shipment |
| POST | `/v2/posting/fbs/cancel-reason/list` | `PostingAPI_GetPostingFbsCancelReasonList` | FBS | Shipments cancellation reasons |
| POST | `/v2/posting/fbs/digital/act/check-status` | `PostingAPI_PostingFBSDigitalActCheckStatus` | DeliveryFBS | Generating status of digital acceptance and transfer certificate and waybill |
| POST | `/v2/posting/fbs/digital/act/get-pdf` | `PostingAPI_PostingFBSGetDigitalAct` | DeliveryFBS | Get digital shipping certificate |
| POST | `/v2/posting/fbs/get-by-barcode` | `PostingAPI_GetFbsPostingByBarcode` | FBS | Get shipment data by barcode |
| POST | `/v2/posting/fbs/package-label` | `PostingAPI_PostingFBSPackageLabel` | FBS | Print the labeling |
| POST | `/v2/posting/fbs/package-label/create` | `PostingAPI_CreateLabelBatchV2` | FBS | Create a task to generate a label |
| POST | `/v2/posting/fbs/product/cancel` | `PostingAPI_CancelFbsPostingProduct` | FBS | Cancel sending some products in the shipment |
| POST | `/v2/posting/fbs/product/country/list` | `PostingAPI_ListCountryProductFbsPostingV2` | FBS | List of manufacturing countries |
| POST | `/v2/posting/fbs/product/country/set` | `PostingAPI_SetCountryProductFbsPostingV2` | FBS | Set the manufacturing country |
| GET | `/v2/product/certificate/accordance-types/list` | `CertificateAccordanceTypes` | CertificationAPI | List of accordance types (version 2) |
| POST | `/v2/product/certification/list` | `ProductAPI_ProductCertificationList` | CertificationAPI | List of certified categories |
| POST | `/v2/product/info/stocks-by-warehouse/fbs` | `GetProductInfoStocksByWarehouseFbsV2` | Prices&StocksAPI | Get stocks in seller warehouses |
| POST | `/v2/product/pictures/info` | `ProductAPI_ProductInfoPicturesV2` | ProductAPI | Get products images |
| POST | `/v2/products/delete` | `ProductAPI_DeleteProducts` | ProductAPI | Remove a product without an SKU from the archive |
| POST | `/v2/products/stocks` | `ProductAPI_ProductsStocksV2` | Prices&StocksAPI | Update the quantity of products in stock |
| POST | `/v2/report/returns/create` | `ReportAPI_ReportReturnsCreate` | ReportAPI | Report on returns |
| POST | `/v2/returns/rfbs/compensate` | `RFBSReturnsAPI_ReturnsRfbsCompensateV2` | RFBSReturnsAPI | Compensate partial cost |
| POST | `/v2/returns/rfbs/get` | `RFBSReturnsAPI_ReturnsRfbsGetV2` | RFBSReturnsAPI | Get information about a return request |
| POST | `/v2/returns/rfbs/list` | `RFBSReturnsAPI_ReturnsRfbsListV2` | RFBSReturnsAPI | Get a list of return requests |
| POST | `/v2/returns/rfbs/receive-return` | `RFBSReturnsAPI_ReturnsRfbsReceiveReturnV2` | RFBSReturnsAPI | Confirm receipt of a product for check |
| POST | `/v2/returns/rfbs/reject` | `RFBSReturnsAPI_ReturnsRfbsRejectV2` | RFBSReturnsAPI | Reject a return request |
| POST | `/v2/returns/rfbs/return-money` | `RFBSReturnsAPI_ReturnsRfbsReturnMoneyV2` | RFBSReturnsAPI | Refund the customer |
| POST | `/v2/returns/rfbs/verify` | `RFBSReturnsAPI_ReturnsRfbsVerifyV2` | RFBSReturnsAPI | Approve a return request |
| POST | `/v2/review/list` | `ReviewListV2` | ReviewAPI | Get list of reviews |
| POST | `/v2/supply-order/timeslot/list` | `SupplyOrderTimeslotList` | FBO | Get list of available supply time slots |
| POST | `/v2/warehouse/list` | `WarehouseListV2` | WarehouseAPI | List of warehouses |
| POST | `/v3/chat/history` | `ChatAPI_ChatHistoryV3` | ChatAPI | Chat history |
| POST | `/v3/chat/list` | `ChatAPI_ChatListV3` | ChatAPI | Chats list |
| POST | `/v3/finance/transaction/list` | `FinanceAPI_FinanceTransactionListV3` | FinanceAPI | Transactions list |
| POST | `/v3/finance/transaction/totals` | `FinanceAPI_FinanceTransactionTotalV3` | FinanceAPI | Total transactions sum |
| POST | `/v3/posting/fbo/list` | `PostingFboList` | FBO | Get shipment list |
| POST | `/v3/posting/fbs/get` | `PostingAPI_GetFbsPostingV3` | FBS | Get shipment details by identifier (version 3) |
| POST | `/v3/posting/fbs/list` | `PostingAPI_GetFbsPostingListV3` | FBS | Shipments list |
| POST | `/v3/posting/fbs/unfulfilled/list` | `PostingAPI_GetFbsPostingUnfulfilledList` | FBS | List of unprocessed shipments |
| POST | `/v3/posting/multiboxqty/set` | `PostingAPI_PostingMultiBoxQtySetV3` | FBS | Specify number of boxes for multi-box shipments |
| POST | `/v3/product/import` | `ProductAPI_ImportProductsV3` | ProductAPI | Create or update a product |
| POST | `/v3/product/info/list` | `ProductAPI_GetProductInfoList` | ProductAPI | Get a list of products by identifiers |
| POST | `/v3/product/list` | `ProductAPI_GetProductList` | ProductAPI | List of products |
| POST | `/v3/supply-order/get` | `SupplyOrderGet` | FBO | Supply request details |
| POST | `/v3/supply-order/list` | `SupplyOrderList` | FBO | List of supply requests to the Ozon warehouse |
| POST | `/v4/posting/fbs/list` | `PostingFbsList` | FBS | Get shipment list |
| POST | `/v4/posting/fbs/ship` | `PostingAPI_ShipFbsPostingV4` | FBS&rFBSMarks | Pack the order (version 4) |
| POST | `/v4/posting/fbs/ship/package` | `PostingAPI_ShipFbsPostingPackage` | FBS&rFBSMarks | Shipment partial package (version 4) |
| POST | `/v4/posting/fbs/unfulfilled/list` | `PostingFbsUnfulfilledList` | FBS | Get list of unprocessed shipments |
| POST | `/v4/product/info/attributes` | `ProductAPI_GetProductAttributesV4` | ProductAPI | Get a description of the product characteristics |
| POST | `/v4/product/info/limit` | `ProductAPI_GetUploadQuota` | ProductAPI | Product range limit, limits on product creation and update |
| POST | `/v4/product/info/stocks` | `ProductAPI_GetProductInfoStocks` | Prices&StocksAPI | Information about product quantity |
| POST | `/v5/fbs/posting/product/exemplar/status` | `PostingAPI_FbsPostingProductExemplarStatusV5` | FBS&rFBSMarks | Get statuses of product items check |
| POST | `/v5/fbs/posting/product/exemplar/validate` | `PostingAPI_FbsPostingProductExemplarValidateV5` | FBS&rFBSMarks | Validate labeling codes |
| POST | `/v5/product/info/prices` | `ProductAPI_GetProductInfoPrices` | Prices&StocksAPI | Get product price information |
| POST | `/v6/fbs/posting/product/exemplar/create-or-get` | `PostingAPI_FbsPostingProductExemplarCreateOrGetV6` | FBS&rFBSMarks | Get created items data |
| POST | `/v6/fbs/posting/product/exemplar/set` | `PostingAPI_FbsPostingProductExemplarSetV6` | FBS&rFBSMarks | Check and save items data |
