// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20CctpV2Minimal {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to,uint256 amount) external returns (bool);
    function transferFrom(address from,address to,uint256 amount) external returns (bool);
    function approve(address spender,uint256 amount) external returns (bool);
}

interface ITokenMessengerV2ExactFeeMinimal {
    function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold) external;
    function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes calldata hookData) external;
}

/// @notice Ownerless exact-1bp AssetFare collection plus direct Circle CCTP V2 burn.
/// @dev No business amount maximum and no AssetFare fee maximum. The provider
/// fee safety bound is separate and remains at 5 USDC / 5% of the burn.
contract AssetFareDirectCctpExecutorV2 {
    IERC20CctpV2Minimal public immutable USDC;
    ITokenMessengerV2ExactFeeMinimal public immutable TOKEN_MESSENGER;
    address public immutable FEE_RECIPIENT;
    uint32 public immutable SOURCE_DOMAIN;
    uint256 public constant ROUTE_FEE_BPS=1;
    bytes32 public constant FORWARD_EXISTING_RECIPIENT=0x636374702d666f72776172640000000000000000000000000000000000000000;
    bytes32 public constant FORWARD_SETUP_HEAD=0x636374702d666f72776172640000000000000000000000000000000000000021;
    uint256 private locked=1;

    event DirectCctpBurn(address indexed caller,uint32 indexed destinationDomain,bytes32 indexed mintRecipient,uint256 inputUSDC,uint256 feeUSDC,uint256 burnUSDC,uint256 maxCctpFee,uint32 minFinalityThreshold);

    constructor(address usdc,address tokenMessenger,address feeRecipient,uint32 sourceDomain) {
        require(usdc!=address(0)&&tokenMessenger!=address(0)&&feeRecipient!=address(0),"zero address");
        require(sourceDomain==3||sourceDomain==6,"unsupported source domain");
        require(IERC20CctpV2Minimal(usdc).decimals()==6,"USDC decimals");
        USDC=IERC20CctpV2Minimal(usdc);TOKEN_MESSENGER=ITokenMessengerV2ExactFeeMinimal(tokenMessenger);FEE_RECIPIENT=feeRecipient;SOURCE_DOMAIN=sourceDomain;
    }

    modifier nonReentrant(){require(locked==1,"reentrant");locked=2;_;locked=1;}
    modifier beforeDeadline(uint256 deadline){require(block.timestamp<=deadline,"expired");_;}

    function bridgeUSDC(uint256 amountIn,uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint256 maxCctpFee,uint32 minFinalityThreshold,bytes calldata hookData,uint256 deadline) external nonReentrant beforeDeadline(deadline) returns(uint256 burnUSDC) {
        require(amountIn>=10_000&&mintRecipient!=bytes32(0),"invalid input");
        require(destinationDomain!=SOURCE_DOMAIN&&(destinationDomain==3||destinationDomain==5||destinationDomain==6),"unsupported destination");
        require(minFinalityThreshold==1000||minFinalityThreshold==2000,"invalid finality");
        uint256 routeFee=amountIn/10_000;burnUSDC=amountIn-routeFee;
        require(routeFee>0&&burnUSDC>maxCctpFee&&maxCctpFee<=5_000_000&&maxCctpFee<=burnUSDC/20,"CCTP fee out of range");
        uint256 beforeBalance=USDC.balanceOf(address(this));_transferFrom(msg.sender,address(this),amountIn);_approve(address(TOKEN_MESSENGER),burnUSDC);
        if(hookData.length==0)TOKEN_MESSENGER.depositForBurn(burnUSDC,destinationDomain,mintRecipient,address(USDC),destinationCaller,maxCctpFee,minFinalityThreshold);
        else{_validateForwardHook(hookData);TOKEN_MESSENGER.depositForBurnWithHook(burnUSDC,destinationDomain,mintRecipient,address(USDC),destinationCaller,maxCctpFee,minFinalityThreshold,hookData);}
        _approve(address(TOKEN_MESSENGER),0);_transfer(FEE_RECIPIENT,routeFee);require(USDC.balanceOf(address(this))==beforeBalance,"retained USDC");
        _emitBurn(destinationDomain,mintRecipient,amountIn,routeFee,burnUSDC,maxCctpFee,minFinalityThreshold);
    }

    function _validateForwardHook(bytes calldata hookData) private pure {bytes32 head;assembly{head:=calldataload(hookData.offset)}require((hookData.length==32&&head==FORWARD_EXISTING_RECIPIENT)||(hookData.length==65&&head==FORWARD_SETUP_HEAD&&uint8(hookData[32])==1),"invalid forward hook");}
    function _emitBurn(uint32 destinationDomain,bytes32 mintRecipient,uint256 amountIn,uint256 routeFee,uint256 burnUSDC,uint256 maxCctpFee,uint32 minFinalityThreshold) private {emit DirectCctpBurn(msg.sender,destinationDomain,mintRecipient,amountIn,routeFee,burnUSDC,maxCctpFee,minFinalityThreshold);}
    function _approve(address spender,uint256 amount) private {require(USDC.approve(spender,amount),"approve");}
    function _transfer(address to,uint256 amount) private {require(USDC.transfer(to,amount),"transfer");}
    function _transferFrom(address from,address to,uint256 amount) private {require(USDC.transferFrom(from,to,amount),"transferFrom");}
}
