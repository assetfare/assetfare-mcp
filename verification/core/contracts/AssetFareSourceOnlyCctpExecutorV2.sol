// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAssetFareSourceUSDCV2 {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to,uint256 amount) external returns (bool);
    function transferFrom(address from,address to,uint256 amount) external returns (bool);
    function approve(address spender,uint256 amount) external returns (bool);
}

interface IAssetFareSourceTokenMessengerV2 {
    function depositForBurn(
        uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,
        bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold
    ) external;
}

/// @notice Ownerless Polygon/Optimism native-USDC source-only CCTP executor.
/// @dev No business amount maximum: the caller owns the funds and independently
/// verifies/signs the exact amount. Safety comes from pinned assets/protocol,
/// no-forward Standard-2000 semantics, minimum output at CCTP, deadline,
/// non-reentrancy, approval reset, immutable exact 1bp fee, and zero retention.
contract AssetFareSourceOnlyCctpExecutorV2 {
    IAssetFareSourceUSDCV2 public immutable USDC;
    IAssetFareSourceTokenMessengerV2 public immutable TOKEN_MESSENGER;
    address public immutable FEE_RECIPIENT;
    uint32 public immutable SOURCE_DOMAIN;
    uint256 public constant ROUTE_FEE_BPS=1;
    uint256 public constant MIN_INPUT_USDC=1_000_000;
    uint256 public constant MAX_DEADLINE_WINDOW=300;
    uint256 private locked=1;

    event PolygonSourceCctpBurn(address indexed caller,uint32 indexed destinationDomain,bytes32 indexed mintRecipient,uint256 inputUSDC,uint256 feeUSDC,uint256 burnUSDC,uint256 maxCctpFee,uint32 minFinalityThreshold);
    event OptimismSourceCctpBurn(address indexed caller,uint32 indexed destinationDomain,bytes32 indexed mintRecipient,uint256 inputUSDC,uint256 feeUSDC,uint256 burnUSDC,uint256 maxCctpFee,uint32 minFinalityThreshold);

    constructor(address usdc,address tokenMessenger,address feeRecipient,uint32 sourceDomain) {
        require(usdc!=address(0)&&tokenMessenger!=address(0)&&feeRecipient!=address(0),"zero address");
        require(
            (block.chainid==137&&sourceDomain==7)||(block.chainid==10&&sourceDomain==2),
            "source chain/domain"
        );
        require(IAssetFareSourceUSDCV2(usdc).decimals()==6,"USDC decimals");
        USDC=IAssetFareSourceUSDCV2(usdc);TOKEN_MESSENGER=IAssetFareSourceTokenMessengerV2(tokenMessenger);
        FEE_RECIPIENT=feeRecipient;SOURCE_DOMAIN=sourceDomain;
    }

    modifier nonReentrant(){require(locked==1,"reentrant");locked=2;_;locked=1;}
    modifier beforeDeadline(uint256 deadline){require(block.timestamp<=deadline&&deadline<=block.timestamp+MAX_DEADLINE_WINDOW,"invalid deadline");_;}

    function bridgeUSDC(
        uint256 amountIn,uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,
        uint256 maxCctpFee,uint32 minFinalityThreshold,bytes calldata hookData,uint256 deadline
    ) external nonReentrant beforeDeadline(deadline) returns(uint256 burnUSDC) {
        require(amountIn>=MIN_INPUT_USDC&&mintRecipient!=bytes32(0),"invalid input");
        require(destinationDomain==3||destinationDomain==6,"unsupported destination");
        require(destinationCaller==bytes32(0)&&maxCctpFee==0&&minFinalityThreshold==2000&&hookData.length==0,"no-forward standard only");
        uint256 routeFee=amountIn/10_000;
        burnUSDC=amountIn-routeFee;require(burnUSDC>0,"zero burn");
        uint256 beforeBalance=USDC.balanceOf(address(this));
        _transferFrom(msg.sender,address(this),amountIn);_approve(address(TOKEN_MESSENGER),burnUSDC);
        TOKEN_MESSENGER.depositForBurn(burnUSDC,destinationDomain,mintRecipient,address(USDC),bytes32(0),0,2000);
        _approve(address(TOKEN_MESSENGER),0);_transfer(FEE_RECIPIENT,routeFee);
        require(USDC.balanceOf(address(this))==beforeBalance,"retained USDC");
        _emitBurn(destinationDomain,mintRecipient,amountIn,routeFee,burnUSDC);
    }

    function _emitBurn(uint32 destinationDomain,bytes32 mintRecipient,uint256 amountIn,uint256 routeFee,uint256 burnUSDC) private {
        if(SOURCE_DOMAIN==7)emit PolygonSourceCctpBurn(msg.sender,destinationDomain,mintRecipient,amountIn,routeFee,burnUSDC,0,2000);
        else emit OptimismSourceCctpBurn(msg.sender,destinationDomain,mintRecipient,amountIn,routeFee,burnUSDC,0,2000);
    }

    function _approve(address spender,uint256 amount) private {require(USDC.approve(spender,amount),"approve");}
    function _transfer(address to,uint256 amount) private {require(USDC.transfer(to,amount),"transfer");}
    function _transferFrom(address from,address to,uint256 amount) private {require(USDC.transferFrom(from,to,amount),"transferFrom");}
}
