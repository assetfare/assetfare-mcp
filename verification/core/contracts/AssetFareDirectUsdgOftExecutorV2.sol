// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20UsdgV2Minimal {function balanceOf(address) external view returns(uint256);function decimals() external view returns(uint8);function transfer(address,uint256) external returns(bool);function transferFrom(address,address,uint256) external returns(bool);}
interface IUsdgOftV2Minimal {
    struct SendParam {uint32 dstEid;bytes32 to;uint256 amountLD;uint256 minAmountLD;bytes extraOptions;bytes composeMsg;bytes oftCmd;}
    struct MessagingFee {uint256 nativeFee;uint256 lzTokenFee;}
    function token() external view returns(address);function sharedDecimals() external view returns(uint8);function approvalRequired() external view returns(bool);function peers(uint32) external view returns(bytes32);function send(SendParam calldata,MessagingFee calldata,address) external payable;
}

/// @notice Ownerless Robinhood USDG OFT send with exact 1bp AssetFare fee.
/// @dev No business amount maximum and no service-fee maximum.
contract AssetFareDirectUsdgOftExecutorV2 {
    IERC20UsdgV2Minimal public immutable USDG;IUsdgOftV2Minimal public immutable OFT;address public immutable FEE_RECIPIENT;bytes32 public immutable SOLANA_PEER;
    uint32 public constant SOLANA_EID=30168;uint256 public constant ROUTE_FEE_BPS=1;uint256 private locked=1;
    event DirectUsdgOftSend(address indexed caller,bytes32 indexed recipient,uint256 inputUSDG,uint256 feeUSDG,uint256 sentUSDG,uint256 minimumOutput,uint256 nativeFee);
    constructor(address usdg,address oft,address feeRecipient,bytes32 solanaPeer){require(usdg!=address(0)&&oft!=address(0)&&feeRecipient!=address(0)&&solanaPeer!=bytes32(0),"zero input");require(IERC20UsdgV2Minimal(usdg).decimals()==6,"USDG decimals");require(IUsdgOftV2Minimal(oft).token()==usdg&&IUsdgOftV2Minimal(oft).sharedDecimals()==6&&!IUsdgOftV2Minimal(oft).approvalRequired()&&IUsdgOftV2Minimal(oft).peers(SOLANA_EID)==solanaPeer,"OFT identity");USDG=IERC20UsdgV2Minimal(usdg);OFT=IUsdgOftV2Minimal(oft);FEE_RECIPIENT=feeRecipient;SOLANA_PEER=solanaPeer;}
    modifier nonReentrant(){require(locked==1,"reentrant");locked=2;_;locked=1;}modifier beforeDeadline(uint256 deadline){require(block.timestamp<=deadline,"expired");_;}
    function bridgeUSDG(uint256 amountIn,bytes32 recipient,uint256 minimumOutput,uint256 nativeFee,uint256 deadline) external payable nonReentrant beforeDeadline(deadline) returns(uint256 sentUSDG){
        require(amountIn>=10_000&&recipient!=bytes32(0)&&msg.value==nativeFee,"invalid input");uint256 routeFee=amountIn/10_000;sentUSDG=amountIn-routeFee;require(routeFee>0&&minimumOutput>0&&minimumOutput<=sentUSDG,"minimum output");
        uint256 beforeBalance=USDG.balanceOf(address(this));_transferFrom(msg.sender,address(this),amountIn);
        IUsdgOftV2Minimal.SendParam memory param=IUsdgOftV2Minimal.SendParam({dstEid:SOLANA_EID,to:recipient,amountLD:sentUSDG,minAmountLD:minimumOutput,extraOptions:"",composeMsg:"",oftCmd:""});
        OFT.send{value:nativeFee}(param,IUsdgOftV2Minimal.MessagingFee(nativeFee,0),msg.sender);_transfer(FEE_RECIPIENT,routeFee);require(USDG.balanceOf(address(this))==beforeBalance,"retained USDG");emit DirectUsdgOftSend(msg.sender,recipient,amountIn,routeFee,sentUSDG,minimumOutput,nativeFee);
    }
    function _transfer(address to,uint256 amount) private {require(USDG.transfer(to,amount),"transfer");}function _transferFrom(address from,address to,uint256 amount) private {require(USDG.transferFrom(from,to,amount),"transferFrom");}
}
